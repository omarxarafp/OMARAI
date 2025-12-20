import 'dotenv/config';
import baileys from '@itsukichan/baileys';
import NodeCache from 'node-cache';

const msgRetryCounterCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });
const messageResponseCache = new NodeCache({ stdTTL: 5, checkperiod: 2 });

// معالج الأخطاء العامة - يمنع توقف البوت
process.on('unhandledRejection', (reason, promise) => {
    const errorMsg = reason?.message || String(reason);
    if (errorMsg.includes('Timed Out') || errorMsg.includes('Request Time-out') || errorMsg.includes('ETIMEDOUT')) {
        console.log('⚠️ Timeout حدث - البوت مستمر في العمل...');
    } else if (errorMsg.includes('rate-overlimit')) {
        console.log('⚠️ Rate limit - البوت ينتظر قليلاً...');
    } else {
        console.error('⚠️ خطأ غير معالج:', errorMsg);
    }
});

process.on('uncaughtException', (error) => {
    console.error('⚠️ استثناء غير ملتقط:', error.message);
});
const { default: makeWASocket, DisconnectReason, Browsers, jidDecode, jidNormalizedUser, useMultiFileAuthState, downloadMediaMessage, proto, generateWAMessageFromContent, makeCacheableSignalKeyStore } = baileys;
import { Boom } from '@hapi/boom';
import pino from 'pino';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { request } from 'undici';
import axios from 'axios';
import sharp from 'sharp';
import AdmZip from 'adm-zip';
import config from './config/config.js';
import { processMessage, processMessageWithQuote, clearHistory, addContext, moderateGroupMessage, checkAndBlockUser } from './src/utils/gemini-brain.js';
import { blocklist, users, downloads, groupSettings, antiPrivateSettings, warningsTracker } from './src/storage.js';
import { handleAntiLink, handleAntiBadWords, processGroupAction, isBotAdmin, handleAntiPrivate, setupAntiTimeScheduler, setAntiTime, isUserAdmin, processAntiPrivateAction, blockUserOnWhatsApp, enableAllProtection, getGroupProtectionStatus, setAntiLink, setAntiBadWords } from './src/group-manager.js';
import { sendGamesMenu, sendGamesListMenu, parseInteractiveResponse, GAMES_LIST, sendButtonList, sendListMenu, sendAppSearchResults, sendQuickButtons } from './src/interactive-buttons.js';
import { splitFile, splitFileFromUrl, needsSplitting, getJoinInstructions, cleanupParts, cleanupPartsIfNotCached, MAX_WHATSAPP_SIZE, TEMP_DIR, formatBytes as formatSplitBytes } from './src/utils/file-splitter.js';

const API_SERVER_URL = 'http://localhost:8000';

// Bot Mode: 'all' = groups + private, 'groups' = groups only, 'private' = private only
let BOT_MODE = 'all';
let DEV_MODE = false;

// 1GB limit for regular users, unlimited for VIP/Admin/Developers
const MAX_REGULAR_USER_SIZE = 1 * 1024 * 1024 * 1024; // 1GB for regular users

// Check if user can download large files (developers, VIP, and admins)
function canDownloadLargeFile(senderPhone, isAdmin) {
    return isAdmin || vipUsers.has(senderPhone) || isDeveloper(senderPhone);
}

// Get file size before downloading - supports both package names and direct URLs
async function getFileSizeBeforeDownload(packageNameOrUrl) {
    const API_URL = process.env.API_URL || 'http://localhost:8000';
    try {
        // Check if it's a direct URL or a package name
        const isUrl = packageNameOrUrl.startsWith('http');
        const targetUrl = isUrl ? packageNameOrUrl : `${API_URL}/download/${packageNameOrUrl}`;
        
        const headResponse = await axios.head(targetUrl, { 
            timeout: 30000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36'
            }
        });
        const contentLength = parseInt(headResponse.headers['content-length'] || '0', 10);
        console.log(`📊 حجم الملف: ${formatFileSize(contentLength)}`);
        return contentLength;
    } catch (e) {
        console.log(`⚠️ فشل فحص حجم الملف: ${e.message}`);
        return 0; // Unknown size, allow download
    }
}

function setBotMode(mode) {
    const validModes = ['all', 'groups', 'private', 'dev'];
    const lowerMode = mode.toLowerCase();
    if (validModes.includes(lowerMode)) {
        if (lowerMode === 'dev') {
            DEV_MODE = true;
        } else {
            DEV_MODE = false;
            BOT_MODE = lowerMode;
        }
        return true;
    }
    return false;
}

function getBotMode() {
    return BOT_MODE;
}

function shouldProcessMessage(isGroup, isAdmin) {
    if (isAdmin) return true;
    if (DEV_MODE) return false;
    if (BOT_MODE === 'all') return true;
    if (BOT_MODE === 'groups' && isGroup) return true;
    if (BOT_MODE === 'private' && !isGroup) return true;
    return false;
}

function calculateSimilarity(str1, str2) {
    if (!str1 || !str2) return 0;
    const s1 = str1.toLowerCase().trim();
    const s2 = str2.toLowerCase().trim();
    
    if (s1 === s2) return 1;
    if (s2.includes(s1) || s1.includes(s2)) return 0.9;
    
    const words1 = s1.split(/\s+/);
    const words2 = s2.split(/\s+/);
    let matchCount = 0;
    for (const w1 of words1) {
        if (words2.some(w2 => w2.includes(w1) || w1.includes(w2))) {
            matchCount++;
        }
    }
    return matchCount / Math.max(words1.length, 1);
}

async function searchAPKPure(query, num = 10) {
    try {
        const [searchResponse, an1Response, apkmbResponse, gamessapkResponse, traidSoftResponse] = await Promise.all([
            axios.get(`${API_SERVER_URL}/search`, {
                params: { q: query, num },
                timeout: 15000
            }).catch(e => ({ data: { results: [] } })),
            axios.get(`${API_SERVER_URL}/search-an1`, {
                params: { q: query, num: 5 },
                timeout: 15000
            }).catch(e => ({ data: { results: [] } })),
            axios.get(`${API_SERVER_URL}/search-apkmb`, {
                params: { q: query, num: 5 },
                timeout: 15000
            }).catch(e => ({ data: { results: [] } })),
            axios.get(`${API_SERVER_URL}/search-gamessapk`, {
                params: { q: query, num: 5 },
                timeout: 15000
            }).catch(e => ({ data: { results: [] } })),
            axios.get(`${API_SERVER_URL}/search-traidsoft`, {
                params: { q: query, num: 5 },
                timeout: 15000
            }).catch(e => ({ data: { results: [] } }))
        ]);
        
        const normalResults = searchResponse.data.results || [];
        const an1Results = an1Response.data.results || [];
        const apkmbResults = apkmbResponse.data.results || [];
        const gamessapkResults = gamessapkResponse.data.results || [];
        const traidSoftResults = traidSoftResponse.data.results || [];
        
        const combined = [...normalResults, ...an1Results, ...apkmbResults, ...gamessapkResults, ...traidSoftResults];
        
        combined.forEach(app => {
            app.similarity = calculateSimilarity(query, app.title || app.name || '');
        });
        
        combined.sort((a, b) => b.similarity - a.similarity);
        
        console.log(`[Search] Found ${normalResults.length} APKPure + ${an1Results.length} AN1 + ${apkmbResults.length} GetModsAPK + ${gamessapkResults.length} GamesAPK + ${traidSoftResults.length} TraidSoft (sorted by similarity)`);
        return combined;
    } catch (error) {
        console.error('[Search] Error:', error.message);
        return [];
    }
}

async function getAppFromAPKPure(appId) {
    try {
        const response = await axios.get(`${API_SERVER_URL}/app/${appId}`, {
            timeout: 15000
        });
        return response.data;
    } catch (error) {
        console.error('[APKPure App] Error:', error.message);
        return null;
    }
}

const loadedPlugins = [];
const commandPlugins = [];

async function loadPlugins() {
    const pluginsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'plugins');

    if (!fs.existsSync(pluginsDir)) {
        console.log('📁 مجلد plugins غير موجود');
        return;
    }

    const pluginFiles = fs.readdirSync(pluginsDir).filter(file => file.endsWith('.js'));

    for (const file of pluginFiles) {
        try {
            const pluginPath = path.join(pluginsDir, file);
            const plugin = await import(`file://${pluginPath}`);

            if (plugin.default && plugin.default.patterns && plugin.default.handler) {
                loadedPlugins.push(plugin.default);
            }
            
            if (plugin.default && plugin.default.commands && plugin.default.handler) {
                commandPlugins.push(plugin.default);
            }
        } catch (error) {
            console.error(`❌ فشل تحميل plugin ${file}:`, error.message);
        }
    }

    console.log(`📦 تحمّلو ${loadedPlugins.length} plugins و ${commandPlugins.length} command plugins`);
}

function findCommandPlugin(text) {
    const lowerText = text.toLowerCase().trim();
    for (const plugin of commandPlugins) {
        if (plugin.commands && plugin.commands.some(cmd => lowerText === cmd.toLowerCase() || lowerText.startsWith(cmd.toLowerCase() + ' '))) {
            return plugin;
        }
    }
    return null;
}

async function handleCommandPlugin(sock, remoteJid, text, msg, senderPhone) {
    const plugin = findCommandPlugin(text);
    if (!plugin) return false;

    const utils = {
        poweredBy: config.developer.pluginBranding,
        react: async (sock, msg, emoji) => {
            try {
                await sock.sendMessage(remoteJid, { react: { text: emoji, key: msg.key } });
            } catch (e) {
                console.error(`❌ فشل إرسال تفاعل:`, e.message);
            }
        }
    };

    try {
        await plugin.handler(sock, remoteJid, text, msg, utils, senderPhone);
        console.log(`✅ تمت معالجة الأمر بواسطة ${plugin.name}`);
        return true;
    } catch (error) {
        console.error(`❌ خطأ في plugin ${plugin.name}:`, error.message);
        return false;
    }
}

function extractUrl(text) {
    const urlRegex = /(https?:\/\/[^\s]+)/gi;
    const matches = text.match(urlRegex);
    const url = matches ? matches[0] : null;
    if (url) {
        console.log(`🔗 تم استخراج رابط: ${url}`);
    }
    return url;
}

function findMatchingPlugin(url) {
    console.log(`🔍 البحث عن plugin للرابط: ${url}`);
    for (const plugin of loadedPlugins) {
        for (const pattern of plugin.patterns) {
            if (pattern.test(url)) {
                console.log(`✅ تم العثور على plugin: ${plugin.name}`);
                return plugin;
            }
        }
    }
    console.log(`❌ لم يتم العثور على plugin للرابط`);
    return null;
}

async function handlePluginUrl(sock, remoteJid, url, msg, senderPhone) {
    console.log(`🔌 محاولة معالجة الرابط بواسطة plugin: ${url}`);

    const plugin = findMatchingPlugin(url);

    if (!plugin) {
        console.log(`⚠️ لا يوجد plugin مناسب للرابط: ${url}`);
        return false;
    }

    console.log(`🎯 Plugin سيعالج: ${plugin.name} - ${url}`);

    const utils = {
        poweredBy: config.developer.pluginBranding,
        react: async (sock, msg, emoji) => {
            try {
                await sock.sendMessage(remoteJid, { react: { text: emoji, key: msg.key } });
            } catch (e) {
                console.error(`❌ فشل إرسال تفاعل:`, e.message);
            }
        }
    };

    try {
        await plugin.handler(sock, remoteJid, url, msg, utils);
        console.log(`✅ تمت معالجة الرابط بنجاح بواسطة ${plugin.name}`);
        return true;
    } catch (error) {
        console.error(`❌ خطأ في plugin ${plugin.name}:`, error.message);
        console.error(error);
        return false;
    }
}

const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const suppressPatterns = [
    /Closing session/i,
    /Closing open session/i,
    /in favor of incoming/i,
    /prekey bundle/i,
    /SessionEntry/,
    /_chains:/,
    /registrationId:/,
    /currentRatchet:/,
    /ephemeralKeyPair:/,
    /lastRemoteEphemeralKey:/,
    /previousCounter:/,
    /rootKey:/,
    /indexInfo:/,
    /baseKey:/,
    /pendingPreKey:/,
    /signedKeyId:/,
    /preKeyId:/,
    /chainKey:/,
    /chainType:/,
    /messageKeys:/,
    /remoteIdentityKey:/,
    /<Buffer/,
    /Buffer </,
    /privKey:/,
    /pubKey:/,
    /closed:/,
    /used:/,
    /created:/,
    /baseKeyType:/,
    /Failed to decrypt message/,
    /Session error/,
    /Bad MAC/
];

const stringifyArg = (a) => {
    if (typeof a === 'string') return a;
    if (a === null || a === undefined) return '';
    if (a instanceof Error) return a.message || '';
    try {
        return JSON.stringify(a, (key, value) => {
            if (Buffer.isBuffer(value)) return '<Buffer>';
            return value;
        });
    } catch {
        return String(a);
    }
};

console.log = (...args) => {
    const message = args.map(stringifyArg).join(' ');
    if (!suppressPatterns.some(pattern => pattern.test(message))) {
        originalConsoleLog.apply(console, args);
    }
};

console.error = (...args) => {
    const message = args.map(stringifyArg).join(' ');
    if (!suppressPatterns.some(pattern => pattern.test(message))) {
        originalConsoleError.apply(console, args);
    }
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DOWNLOADS_DIR = path.join(__dirname, 'downloads');

if (!fs.existsSync(DOWNLOADS_DIR)) {
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
    console.log('📁 تخلق المجلد ديال التحميلات');
}

function cleanupOldDownloads() {
    try {
        const files = fs.readdirSync(DOWNLOADS_DIR);
        const now = Date.now();
        const maxAge = 30 * 60 * 1000;

        for (const file of files) {
            const filePath = path.join(DOWNLOADS_DIR, file);
            const stats = fs.statSync(filePath);
            if (now - stats.mtimeMs > maxAge) {
                fs.unlinkSync(filePath);
                console.log(`🗑️ تحيد ملف قديم: ${file}`);
            }
        }
    } catch (error) {
        console.error('غلطة فتنقية الملفات القديمة:', error.message);
    }
}

setInterval(cleanupOldDownloads, 10 * 60 * 1000);

function analyzeXapkContents(xapkBuffer) {
    try {
        const zip = new AdmZip(xapkBuffer);
        const entries = zip.getEntries();

        let apkFile = null;
        let obbFiles = [];
        let splitApks = [];

        for (const entry of entries) {
            const name = entry.entryName.toLowerCase();

            if (name.endsWith('.obb') && !entry.isDirectory) {
                obbFiles.push({
                    name: entry.entryName,
                    buffer: entry.getData(),
                    size: entry.header.size
                });
            } else if (name.endsWith('.apk') && !entry.isDirectory) {
                if (name === 'base.apk' || name.includes('base')) {
                    apkFile = {
                        name: entry.entryName,
                        buffer: entry.getData(),
                        size: entry.header.size
                    };
                } else if (name.includes('split') || name.includes('config')) {
                    splitApks.push({
                        name: entry.entryName,
                        buffer: entry.getData(),
                        size: entry.header.size
                    });
                } else if (!apkFile) {
                    apkFile = {
                        name: entry.entryName,
                        buffer: entry.getData(),
                        size: entry.header.size
                    };
                }
            }
        }

        const hasApkPlusObb = apkFile && obbFiles.length > 0;
        const hasSplitApks = splitApks.length > 0;

        console.log(`📦 تحليل XAPK: APK=${apkFile ? 'نعم' : 'لا'}, OBB=${obbFiles.length}, Split APKs=${splitApks.length}`);

        return {
            hasApkPlusObb,
            hasSplitApks,
            apkFile,
            obbFiles,
            splitApks
        };
    } catch (error) {
        console.error('❌ خطأ في تحليل XAPK:', error.message);
        return {
            hasApkPlusObb: false,
            hasSplitApks: false,
            apkFile: null,
            obbFiles: [],
            splitApks: []
        };
    }
}

function buildApkObbZip(appDetails, apkFile, obbFiles) {
    try {
        const zip = new AdmZip();

        let sanitizedName = appDetails.title
            .replace(/[<>:"/\\|?*]/g, '')
            .replace(/\s+/g, '_')
            .substring(0, 50);

        if (!sanitizedName || sanitizedName.trim() === '') {
            sanitizedName = appDetails.appId || 'app';
        }

        // إضافة ملف APK في الجذر
        const apkFileName = `${sanitizedName}.apk`;
        zip.addFile(apkFileName, apkFile.buffer);
        console.log(`📦 أضفت APK: ${apkFileName}`);

        // إضافة ملفات OBB في مجلد باسم الـ package
        for (const obbFile of obbFiles) {
            const originalObbName = path.basename(obbFile.name);
            const obbPath = `${appDetails.appId}/${originalObbName}`;
            zip.addFile(obbPath, obbFile.buffer);
            console.log(`📦 أضفت OBB: ${obbPath}`);
        }

        const zipBuffer = zip.toBuffer();
        const zipFileName = `${sanitizedName}_مع_OBB.zip`;

        console.log(`✅ تم إنشاء ZIP: ${zipFileName} (${formatFileSize(zipBuffer.length)})`);

        return {
            success: true,
            buffer: zipBuffer,
            fileName: zipFileName,
            size: zipBuffer.length
        };
    } catch (error) {
        console.error('❌ خطأ في إنشاء ZIP:', error.message);
        return {
            success: false,
            error: error.message
        };
    }
}

const logger = pino({ 
    level: 'silent',
    serializers: {
        err: pino.stdSerializers.err
    }
});

function getZipObbTutorial(fileName, packageId, appTitle) {
    const appName = appTitle || fileName.replace(/\.(zip|xapk|apk)$/i, '');
    return `
📦 *طريقة التثبيت:*

*باستعمال ZArchiver:*
1️⃣ افتح الملف بـ ZArchiver
2️⃣ اضغط مطول على *${appName}.apk* > Install
3️⃣ انسخ مجلد *${packageId}* للمسار: Android/obb/

⚠️ *مهم جداً:* 
• انقل ملفات OBB قبل تشغيل التطبيق
• إلا غادي يطلب منك تحميل بيانات إضافية

💡 ماعندكش ZArchiver؟ صيفط: *zarchiver*`;
}

function getXapkInstallTutorial(appTitle) {
    return `
📦 *طريقة تثبيت XAPK:*

*باستعمال ZArchiver:*
1️⃣ افتح المجلد بـ ZArchiver
2️⃣ ارجع للوراء سوف تجد التطبيق باسم *${appTitle}*
3️⃣ اضغط مطول > Install (تثبيت)

⚠️ *مهم:* 
• ماتفتحش الملف، افتح المجلد فقط
• التثبيت أوتوماتيكي مع ZArchiver

💡 ماعندكش ZArchiver؟ صيفط: *zarchiver*`;
}



const userSessions = new Map();
const requestQueue = new Map();
const blockedNumbers = new Set();
const vipUsers = new Set();
const hourlyMessageTracker = new Map();
const downloadMessageTracker = new Map();
const fastMessageTracker = new Map();
const groupMetadataCache = new Map();
const messageStore = new Map();
const lidToPhoneMap = new Map();
const groupListsStore = new Map();
const hourlyDownloadTracker = new Map();

const HOURLY_DOWNLOAD_LIMIT = 10;

function checkHourlyDownloadLimit(phone) {
    if (isDeveloper(phone)) return { allowed: true, remaining: 999 };
    if (vipUsers.has(phone)) return { allowed: true, remaining: 999 };
    
    const now = Date.now();
    const oneHour = 60 * 60 * 1000;
    let tracker = hourlyDownloadTracker.get(phone);
    
    if (!tracker) {
        tracker = { downloads: [] };
        hourlyDownloadTracker.set(phone, tracker);
    }
    
    tracker.downloads = tracker.downloads.filter(t => now - t < oneHour);
    const remaining = HOURLY_DOWNLOAD_LIMIT - tracker.downloads.length;
    
    if (tracker.downloads.length >= HOURLY_DOWNLOAD_LIMIT) {
        const oldestDownload = Math.min(...tracker.downloads);
        const resetIn = Math.ceil((oneHour - (now - oldestDownload)) / 60000);
        return { allowed: false, remaining: 0, resetIn };
    }
    
    return { allowed: true, remaining };
}

function recordDownload(phone) {
    if (isDeveloper(phone) || vipUsers.has(phone)) return;
    
    let tracker = hourlyDownloadTracker.get(phone);
    if (!tracker) {
        tracker = { downloads: [] };
        hourlyDownloadTracker.set(phone, tracker);
    }
    tracker.downloads.push(Date.now());
}

const LITE_ALTERNATIVES = {
    'facebook': ['facebook-lite', 'Facebook Lite'],
    'messenger': ['messenger-lite', 'Messenger Lite'],
    'instagram': ['instagram-lite', 'Instagram Lite'],
    'twitter': ['twitter-lite', 'Twitter Lite'],
    'tiktok': ['tiktok-lite', 'TikTok Lite'],
    'spotify': ['spotify-lite', 'Spotify Lite'],
    'youtube': ['youtube-go', 'YouTube Go'],
    'pubg': ['pubg-mobile-lite', 'PUBG Mobile Lite'],
    'call of duty': ['cod-mobile-garena', 'COD Mobile Lite'],
    'netflix': ['netflix-lite', 'Netflix Lite'],
    'snapchat': ['snapchat-lite', 'Snapchat Lite'],
    'uber': ['uber-lite', 'Uber Lite'],
};

function getLiteAlternative(appName) {
    if (!appName) return null;
    const lowerName = appName.toLowerCase();
    for (const [key, [packageId, displayName]] of Object.entries(LITE_ALTERNATIVES)) {
        if (lowerName.includes(key)) {
            return { packageId, displayName, originalKeyword: key };
        }
    }
    return null;
}

async function searchAlternativeSource(query, currentSource = 'APKPure') {
    try {
        const alternativeEndpoint = currentSource === 'AN1' ? '/search' : '/search-an1';
        const response = await axios.get(`${API_SERVER_URL}${alternativeEndpoint}`, {
            params: { q: query, num: 5 },
            timeout: 15000
        });
        const results = response.data.results || [];
        console.log(`[Alt Source] Found ${results.length} results from ${currentSource === 'AN1' ? 'APKPure' : 'AN1'}`);
        return results;
    } catch (error) {
        console.error('[Alt Source] Error:', error.message);
        return [];
    }
}

async function getDirectDownloadLink(appId, source = 'APKPure') {
    try {
        if (source === 'AN1') {
            return `https://an1.com/search/?q=${encodeURIComponent(appId)}`;
        }
        return `https://apkpure.net/search?q=${encodeURIComponent(appId)}`;
    } catch (error) {
        console.error('[Direct Link] Error:', error.message);
        return null;
    }
}

// Global semaphore for concurrent request handling
class Semaphore {
    constructor(max) {
        this.max = max;
        this.current = 0;
        this.queue = [];
    }
    
    async acquire() {
        if (this.current < this.max) {
            this.current++;
            return;
        }
        await new Promise(resolve => this.queue.push(resolve));
        this.current++;
    }
    
    release() {
        this.current--;
        if (this.queue.length > 0) {
            const next = this.queue.shift();
            next();
        }
    }
}

// Global semaphore: max 15 concurrent requests (increased from default)
const globalRequestSemaphore = new Semaphore(15);

// Per-user download semaphore tracking
const userDownloadSemaphores = new Map();
function getUserDownloadSemaphore(userId, isAdmin) {
    if (!userDownloadSemaphores.has(userId)) {
        // Developers/VIP/Admins get more concurrent downloads
        const maxDownloads = isAdmin || vipUsers.has(userId.replace(/\D/g, '')) ? 10 : 3;
        userDownloadSemaphores.set(userId, new Semaphore(maxDownloads));
    }
    return userDownloadSemaphores.get(userId);
}

const DEVELOPER_PHONES = config.developer.phones;
const BOT_PROFILE_IMAGE_URL = config.bot.profileImageUrl;
const INSTAGRAM_URL = `تابعني على انستجرام:\n${config.developer.channelUrl}`;
const POWERED_BY = config.developer.poweredBy;
const MAX_FILE_SIZE = config.bot.maxFileSize;
const ZARCHIVER_PACKAGE = config.bot.zarchiverPackage;
const VIP_PASSWORD = config.bot.vipPassword;

const USER_LIMITS = {
    authenticated: config.delays.authenticated,
    unauthenticated: config.delays.unauthenticated
};

const SPAM_LIMITS = config.limits.spam;

let botPresenceMode = 'unavailable'; // 'unavailable' or 'available'
let presenceInterval = null;
let keepAliveInterval = null;
let pairingCodeRequested = false;
let globalSock = null;
let botPhoneNumber = null;
let botImageBuffer = null;
let xapkInstallerBuffer = null;
let xapkInstallerInfo = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_DELAY = 5000;

const badWordsTracker = new Map();
const BAD_WORDS_CONFIG = config.badWords || { enabled: false, words: [], warningThreshold: 2, blockOnExceed: true };
const DEV_NOTIFICATIONS = config.developerNotifications || { enabled: false };

function detectBadWords(text) {
    if (!BAD_WORDS_CONFIG.enabled || !text) return { found: false, words: [] };

    const lowerText = text.toLowerCase().trim();
    const foundWords = [];

    for (const word of BAD_WORDS_CONFIG.words) {
        const lowerWord = word.toLowerCase();
        const escapedWord = lowerWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const wordBoundaryRegex = new RegExp(`(^|[\\s.,!?؟،:;()\\[\\]{}'"\\-])${escapedWord}($|[\\s.,!?؟،:;()\\[\\]{}'"\\-])`, 'i');

        if (wordBoundaryRegex.test(lowerText)) {
            foundWords.push(word);
        }
    }

    return { found: foundWords.length > 0, words: foundWords };
}

function trackBadWords(phone) {
    let count = badWordsTracker.get(phone) || 0;
    count++;
    badWordsTracker.set(phone, count);
    return count;
}

function resetBadWordsCount(phone) {
    badWordsTracker.delete(phone);
}

async function notifyDeveloper(sock, type, data) {
    if (!DEV_NOTIFICATIONS.enabled) return;

    const shouldNotify = {
        'block': DEV_NOTIFICATIONS.notifyOnBlock,
        'badWords': DEV_NOTIFICATIONS.notifyOnBadWords,
        'call': DEV_NOTIFICATIONS.notifyOnCall,
        'error': DEV_NOTIFICATIONS.notifyOnError,
        'spam': DEV_NOTIFICATIONS.notifyOnSpam
    };

    if (!shouldNotify[type]) return;

    const socketToUse = sock || globalSock;
    if (!socketToUse) return;

    const now = new Date().toLocaleString('ar-MA', { timeZone: 'Africa/Casablanca' });

    let notificationText = '';

    switch (type) {
        case 'block':
            notificationText = `🚫 *إشعار بلوك*

📱 الرقم: ${data.phone}
📋 السبب: ${data.reason}
👤 الاسم: ${data.userName || 'غير معروف'}
🕐 الوقت: ${now}`;
            break;

        case 'badWords':
            notificationText = `⚠️ *إشعار كلمات ممنوعة*

📱 الرقم: ${data.phone}
👤 الاسم: ${data.userName || 'غير معروف'}
💬 الرسالة: ${data.message?.substring(0, 100) || 'غير متاحة'}
🔴 الكلمات: ${data.words?.join(', ') || 'غير محددة'}
📊 عدد التحذيرات: ${data.warningCount || 1}
🕐 الوقت: ${now}`;
            break;

        case 'call':
            notificationText = `📞 *إشعار مكالمة*

📱 الرقم: ${data.phone}
👤 الاسم: ${data.userName || 'غير معروف'}
🚫 الحالة: تم رفض المكالمة وبلوك الرقم
🕐 الوقت: ${now}`;
            break;

        case 'error':
            notificationText = `❌ *إشعار خطأ*

📱 الرقم: ${data.phone || 'غير معروف'}
⚠️ الخطأ: ${data.error?.substring(0, 200) || 'غير محدد'}
📍 المكان: ${data.location || 'غير محدد'}
🕐 الوقت: ${now}`;
            break;

        case 'spam':
            notificationText = `🚨 *إشعار سبيام*

📱 الرقم: ${data.phone}
👤 الاسم: ${data.userName || 'غير معروف'}
📋 النوع: ${data.spamType || 'غير محدد'}
🕐 الوقت: ${now}`;
            break;
    }

    for (const devPhone of DEVELOPER_PHONES) {
        try {
            const devJid = `${devPhone}@s.whatsapp.net`;
            await socketToUse.sendMessage(devJid, { text: notificationText });
            console.log(`📤 إشعار للمطور ${devPhone}: ${type}`);
        } catch (error) {
            console.error(`❌ فشل إرسال إشعار للمطور ${devPhone}:`, error.message);
        }
    }
}

function extractAllTextFromMessage(msg, mainText) {
    const allTexts = [mainText || ''];

    try {
        const extendedText = msg?.message?.extendedTextMessage;
        if (extendedText?.contextInfo?.quotedMessage) {
            const quoted = extendedText.contextInfo.quotedMessage;
            if (quoted.conversation) allTexts.push(quoted.conversation);
            if (quoted.extendedTextMessage?.text) allTexts.push(quoted.extendedTextMessage.text);
            if (quoted.imageMessage?.caption) allTexts.push(quoted.imageMessage.caption);
            if (quoted.videoMessage?.caption) allTexts.push(quoted.videoMessage.caption);
            if (quoted.documentMessage?.caption) allTexts.push(quoted.documentMessage.caption);
        }

        if (msg?.message?.buttonsResponseMessage?.selectedDisplayText) {
            allTexts.push(msg.message.buttonsResponseMessage.selectedDisplayText);
        }
        if (msg?.message?.listResponseMessage?.title) {
            allTexts.push(msg.message.listResponseMessage.title);
        }
        if (msg?.message?.templateButtonReplyMessage?.selectedDisplayText) {
            allTexts.push(msg.message.templateButtonReplyMessage.selectedDisplayText);
        }

    } catch (e) {
        console.log('⚠️ خطأ في استخراج النصوص:', e.message);
    }

    return allTexts.filter(t => t && t.trim()).join(' ');
}

function extractQuotedText(msg) {
    try {
        const extendedText = msg?.message?.extendedTextMessage;
        if (extendedText?.contextInfo?.quotedMessage) {
            const quoted = extendedText.contextInfo.quotedMessage;
            if (quoted.conversation) return quoted.conversation;
            if (quoted.extendedTextMessage?.text) return quoted.extendedTextMessage.text;
            if (quoted.imageMessage?.caption) return quoted.imageMessage.caption;
            if (quoted.videoMessage?.caption) return quoted.videoMessage.caption;
            if (quoted.documentMessage?.caption) return quoted.documentMessage.caption;
        }
    } catch (e) {
        console.log('⚠️ خطأ في استخراج النص المقتبس:', e.message);
    }
    return null;
}

async function handleBadWordsMessage(sock, remoteJid, senderPhone, userName, text, msg) {
    const fullText = extractAllTextFromMessage(msg, text);
    const badWordsResult = detectBadWords(fullText);

    if (!badWordsResult.found) return false;

    const warningCount = trackBadWords(senderPhone);

    console.log(`⚠️ كلمات ممنوعة من ${senderPhone}: ${badWordsResult.words.join(', ')} (تحذير ${warningCount})`);

    await notifyDeveloper(sock, 'badWords', {
        phone: senderPhone,
        userName: userName,
        message: text,
        words: badWordsResult.words,
        warningCount: warningCount
    });

    if (warningCount >= BAD_WORDS_CONFIG.warningThreshold && BAD_WORDS_CONFIG.blockOnExceed) {
        await blockUserWithNotification(sock, senderPhone, 'بلوك بسبب استخدام كلمات ممنوعة متكررة', userName);

        const blockMessage = config.messages?.blockedBadWords || `⛔ *تحظرّت نهائياً*

❌ استخدمت كلمات ممنوعة
🚫 السب والشتم ممنوع هنا

البوت ديالنا محترم، وماكنقبلوش هاد الكلام.`;

        await sendBotMessage(sock, remoteJid, { text: `${blockMessage}${POWERED_BY}` }, msg);
        return true;
    }

    const remainingWarnings = BAD_WORDS_CONFIG.warningThreshold - warningCount;
    const warningMessage = `⚠️ *تحذير ${warningCount}/${BAD_WORDS_CONFIG.warningThreshold}*

🚫 الكلمات لي كتبتي ممنوعة هنا!
احترم راسك واحترمنا، وإلا غادي تتبلوكى.

${remainingWarnings > 0 ? `⏰ باقي ليك ${remainingWarnings} فرصة قبل ما تتبلوكى!` : '🔴 هادي آخر فرصة ليك!'}`;

    await sendBotMessage(sock, remoteJid, { text: `${warningMessage}${POWERED_BY}` }, msg);
    return true;
}

async function blockUserWithNotification(sock, phone, reason, userName = null) {
    await blockUser(phone, reason, sock);

    await notifyDeveloper(sock, 'block', {
        phone: phone,
        reason: reason,
        userName: userName
    });
}

function getRandomDelay(min = 1000, max = 3000) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}


function getUserLimits(phone) {
    if (isDeveloper(phone)) {
        return USER_LIMITS.authenticated;
    }
    return USER_LIMITS.unauthenticated;
}

// Removed simulateTyping as per instructions
// function getTypingDuration(textLength) {
//     return 0;
// }

async function humanDelay(phone = null) {
    // تم تعطيل التأخير - رد فوري
    return;
    
    let baseDelay;
    if (phone) {
        const limits = getUserLimits(phone);
        baseDelay = limits.messageDelay;
    } else {
        baseDelay = USER_LIMITS.unauthenticated.messageDelay;
    }

    if (baseDelay > 0) {
        await new Promise(r => setTimeout(r, baseDelay));
    }
}

async function getCachedGroupMetadata(sock, jid) {
    if (groupMetadataCache.has(jid)) {
        const cached = groupMetadataCache.get(jid);
        if (Date.now() - cached.timestamp < 300000) {
            return cached.data;
        }
    }
    try {
        const metadata = await sock.groupMetadata(jid);
        groupMetadataCache.set(jid, { data: metadata, timestamp: Date.now() });
        return metadata;
    } catch (error) {
        console.error('مشكيل فجيبان ديال المجموعة:', error.message);
        return null;
    }
}

function storeMessage(key, message) {
    if (!key || !key.id) return;
    const storeKey = `${key.remoteJid}_${key.id}`;
    messageStore.set(storeKey, message);
    if (messageStore.size > 1000) {
        const keysToDelete = Array.from(messageStore.keys()).slice(0, 200);
        keysToDelete.forEach(k => messageStore.delete(k));
    }
}

function getStoredMessage(key) {
    if (!key || !key.id) return undefined;
    const storeKey = `${key.remoteJid}_${key.id}`;
    return messageStore.get(storeKey) || undefined;
}

async function initDatabase() {
    console.log('📁 البوت يستخدم التخزين المحلي (JSON)');
    const dataDir = path.join(__dirname, 'data');
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
        console.log('📁 تم إنشاء مجلد البيانات');
    }
}

async function simulateTyping(sock, remoteJid, textLength = 50) {
    // تم تعطيل التأخير - رد فوري
    return;
}

async function sendBotMessage(sock, remoteJid, content, originalMsg = null, options = {}) {
    let senderPhone = options.senderPhone || null;

    if (!senderPhone && originalMsg) {
        senderPhone = extractPhoneFromMessage(originalMsg);
    }

    const isSticker = content.sticker !== undefined;
    const isSearchResult = options.isSearchResult || false;
    const isFile = content.document !== undefined || content.video !== undefined || content.audio !== undefined;
    const skipDelay = isSticker || isSearchResult || options.skipDelay;

    // التأخير قبل كل رسالة (ماعدا الاستيكرز ونتائج البحث)
    if (!skipDelay) {
        // تأخير ثابت 1 ثانية فقط
        await humanDelay(senderPhone);
    }

    const messageContent = { ...content };

    if (options.forward) {
        messageContent.contextInfo = {
            ...(messageContent.contextInfo || {}),
            isForwarded: true,
            forwardingScore: 1
        };
    }

    const sendOptions = {};
    if (originalMsg) {
        sendOptions.quoted = originalMsg;
    }

    const sentMsg = await sock.sendMessage(remoteJid, messageContent, sendOptions);
    if (sentMsg && sentMsg.key) {
        storeMessage(sentMsg.key, sentMsg.message);
    }
    return sentMsg;
}

async function downloadBotProfileImage() {
    try {
        if (botImageBuffer) return botImageBuffer;
        console.log('📥 كننزّل صورة البروفايل من URL...');
        const { statusCode, body } = await request(BOT_PROFILE_IMAGE_URL, {
            method: 'GET',
            headersTimeout: 15000,
            bodyTimeout: 15000
        });
        if (statusCode !== 200) throw new Error(`HTTP ${statusCode}`);
        botImageBuffer = Buffer.from(await body.arrayBuffer());
        return botImageBuffer;
    } catch (error) {
        console.error('❌ مشكل فتحميل صورة البوت:', error.message);
        return null;
    }
}

async function downloadXapkInstaller() {
    try {
        if (xapkInstallerBuffer && xapkInstallerInfo) {
            return { buffer: xapkInstallerBuffer, info: xapkInstallerInfo };
        }

        console.log('📥 كننزّل المثبّت ديال XAPK (ZArchiver)...');
        const API_URL = process.env.API_URL || 'http://localhost:8000';

        const { statusCode, headers, body } = await request(`${API_URL}/download/${ZARCHIVER_PACKAGE}`, {
            method: 'GET',
            headersTimeout: 300000,
            bodyTimeout: 300000
        });

        if (statusCode !== 200) throw new Error(`HTTP ${statusCode}`);

        const fileType = headers['x-file-type'] || 'apk';
        const data = Buffer.from(await body.arrayBuffer());
        const fileSize = data.length;

        xapkInstallerBuffer = data;
        xapkInstallerInfo = {
            filename: `ZArchiver.${fileType}`,
            size: fileSize,
            fileType: fileType
        };

        console.log(`✅ تّحمل المثبّت: ${formatFileSize(fileSize)}`);
        return { buffer: xapkInstallerBuffer, info: xapkInstallerInfo };
    } catch (error) {
        console.error('❌ مشكل فتنزيل المثبّت ديال XAPK:', error.message);
        return null;
    }
}

async function setBotProfile(sock) {
    try {
        const imageBuffer = await downloadBotProfileImage();
        if (imageBuffer) {
            await Promise.race([
                sock.updateProfilePicture(sock.user.id, imageBuffer),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 30000))
            ]);
            console.log('✅ تتحدّث صورة البروفايل');
        }
    } catch (error) {
        const errorMsg = error.message || String(error);
        if (errorMsg.includes('Timed Out') || errorMsg.includes('Timeout')) {
            console.log('⚠️ تجاوز الوقت في تحديث صورة البروفايل - سيتم المحاولة لاحقاً');
        } else {
            console.error('⚠️ مشكل فتحديث صورة البروفايل:', errorMsg);
        }
    }
}

const gameData = {
    rps: ['حجر', 'ورقة', 'مقص'],
    capitals: [
        { country: 'المغرب', capital: 'الرباط' },
        { country: 'مصر', capital: 'القاهرة' },
        { country: 'السعودية', capital: 'الرياض' },
        { country: 'الإمارات', capital: 'أبوظبي' },
        { country: 'الجزائر', capital: 'الجزائر' },
        { country: 'تونس', capital: 'تونس' },
        { country: 'فرنسا', capital: 'باريس' },
        { country: 'إسبانيا', capital: 'مدريد' },
        { country: 'ألمانيا', capital: 'برلين' },
        { country: 'بريطانيا', capital: 'لندن' }
    ],
    fortunes: [
        'اليوم يومك! حظ سعيد ينتظرك',
        'خبر سار قادم في طريقك',
        'ستتلقى مفاجأة جميلة',
        'الصبر مفتاح الفرج',
        'فرصة جديدة ستظهر لك قريباً',
        'أحلامك ستتحقق بإذن الله',
        'شخص مميز سيدخل حياتك',
        'نجاح كبير ينتظرك هذا الأسبوع',
        'ابتسم فالأيام القادمة أفضل',
        'ثق بنفسك وانطلق'
    ]
};

async function handleGameStart(sock, remoteJid, msg, game, session, userId, senderPhone) {
    const POWERED_BY = config.developer.poweredBy;
    
    switch (game.id) {
        case 'game_1':
            session.gameData.secretNumber = null;
            await sendBotMessage(sock, remoteJid, {
                text: `✊ *حجر ورقة مقص*\n\nاختر:\n1. حجر ✊\n2. ورقة ✋\n3. مقص ✌️\n\nأرسل رقم اختيارك${POWERED_BY}`
            }, msg);
            break;
            
        case 'game_2':
            session.gameData.secretNumber = Math.floor(Math.random() * 100) + 1;
            session.gameData.attempts = 0;
            await sendBotMessage(sock, remoteJid, {
                text: `🔢 *خمن الرقم*\n\nفكرت في رقم من 1 إلى 100\nحاول تخمينه!\n\nأرسل رقمك${POWERED_BY}`
            }, msg);
            break;
            
        case 'game_6':
            const randomCountry = gameData.capitals[Math.floor(Math.random() * gameData.capitals.length)];
            session.gameData.currentQuestion = randomCountry;
            await sendBotMessage(sock, remoteJid, {
                text: `🌍 *تخمين العاصمة*\n\nما هي عاصمة *${randomCountry.country}*?\n\nأرسل إجابتك${POWERED_BY}`
            }, msg);
            break;
            
        case 'game_7':
            const num1 = Math.floor(Math.random() * 50) + 1;
            const num2 = Math.floor(Math.random() * 50) + 1;
            const ops = ['+', '-', '*'];
            const op = ops[Math.floor(Math.random() * ops.length)];
            let answer;
            if (op === '+') answer = num1 + num2;
            else if (op === '-') answer = num1 - num2;
            else answer = num1 * num2;
            session.gameData.mathAnswer = answer;
            await sendBotMessage(sock, remoteJid, {
                text: `➕ *حساب سريع*\n\nما ناتج: ${num1} ${op} ${num2} = ?\n\nأرسل الجواب${POWERED_BY}`
            }, msg);
            break;
            
        case 'game_10':
            const fortune = gameData.fortunes[Math.floor(Math.random() * gameData.fortunes.length)];
            session.state = 'idle';
            session.gameData = null;
            userSessions.set(userId, session);
            await sendBotMessage(sock, remoteJid, {
                text: `🔮 *حظك اليوم*\n\n${fortune}\n\n✨ أتمنى لك يوماً سعيداً!\n\nأرسل *games* للعب مرة أخرى${POWERED_BY}`
            }, msg);
            break;
            
        default:
            await sendBotMessage(sock, remoteJid, {
                text: `*${game.title}*\n\n${game.description}\n\nهذه اللعبة قيد التطوير، جرب لعبة أخرى!\n\nأرسل *games* لقائمة الألعاب${POWERED_BY}`
            }, msg);
            session.state = 'idle';
            session.gameData = null;
            userSessions.set(userId, session);
    }
}


async function getUserProfileInfo(sock, jid, senderPhone, userName) {
    const userInfo = {
        name: userName || 'مستخدم',
        phone: senderPhone,
        profilePic: null,
        status: null,
        about: null
    };

    try {
        try {
            const ppUrl = await sock.profilePictureUrl(jid, 'image');
            if (ppUrl) {
                const { statusCode, body } = await request(ppUrl, {
                    method: 'GET',
                    headersTimeout: 10000,
                    bodyTimeout: 10000
                });
                if (statusCode === 200) {
                    userInfo.profilePic = Buffer.from(await body.arrayBuffer());
                }
            }
        } catch (ppError) {
        }

        try {
            const status = await sock.fetchStatus(jid);
            if (status && status.status) {
                userInfo.status = status.status;
            }
        } catch (statusError) {
        }

    } catch (error) {
    }

    return userInfo;
}

function decodeJid(jid) {
    if (!jid) return null;
    try {
        const decoded = jidDecode(jid);
        return decoded;
    } catch (error) {
        return null;
    }
}

function isLidFormat(jid) {
    if (!jid) return false;
    return jid.endsWith('@lid') || jid.includes('@lid');
}

function getSenderPhone(remoteJid, participant, altJid = null) {
    let jid = remoteJid;
    if (remoteJid.endsWith('@g.us') && participant) {
        jid = participant;
    }

    const decoded = decodeJid(jid);
    if (!decoded) {
        return jid.replace('@s.whatsapp.net', '').replace(/@.*$/, '');
    }

    if (decoded.server === 'lid') {
        if (altJid) {
            const altDecoded = decodeJid(altJid);
            if (altDecoded && altDecoded.server === 's.whatsapp.net') {
                lidToPhoneMap.set(jid, altDecoded.user);
                return altDecoded.user;
            }
        }
        if (lidToPhoneMap.has(jid)) {
            return lidToPhoneMap.get(jid);
        }
        return decoded.user;
    }

    return decoded.user || jid.replace('@s.whatsapp.net', '').replace(/@.*$/, '');
}

function isValidPhoneNumber(phone) {
    if (!phone) return false;
    const cleaned = phone.replace(/\D/g, '');
    return cleaned.length >= 10 && cleaned.length <= 15 && /^\d+$/.test(cleaned);
}

function getUserId(remoteJid, participant) {
    if (remoteJid.endsWith('@g.us') && participant) {
        return participant;
    }
    return remoteJid;
}

function extractPhoneFromMessage(msg) {
    const remoteJid = msg.key?.remoteJid;
    const participant = msg.key?.participant;
    const remoteJidAlt = msg.key?.remoteJidAlt;
    const participantAlt = msg.key?.participantAlt;

    let altJid = null;
    if (remoteJid?.endsWith('@g.us') && participantAlt) {
        altJid = participantAlt;
    } else if (remoteJidAlt) {
        altJid = remoteJidAlt;
    }

    return getSenderPhone(remoteJid, participant, altJid);
}

function isDeveloper(phone) {
    const cleanPhone = phone.replace(/\D/g, '');
    if (botPhoneNumber && (cleanPhone === botPhoneNumber || cleanPhone.endsWith(botPhoneNumber))) {
        return true;
    }
    return DEVELOPER_PHONES.some(devPhone => cleanPhone === devPhone || cleanPhone.endsWith(devPhone));
}

async function checkBlacklist(phone) {
    if (blockedNumbers.has(phone)) return true;
    if (blocklist.isBlocked(phone)) {
        blockedNumbers.add(phone);
        return true;
    }
    return false;
}

async function blockUser(phone, reason, sock = null) {
    blockedNumbers.add(phone);
    blocklist.add(phone, reason);
    console.log(`🚫 تبلوكى: ${phone} - السبب: ${reason}`);

    const socketToUse = sock || globalSock;
    if (socketToUse) {
        try {
            const jid = `${phone}@s.whatsapp.net`;
            await socketToUse.updateBlockStatus(jid, 'block');
            console.log(`✅ تبلوكى الرقم فواتساب: ${phone}`);
        } catch (blockError) {
            console.error('❌ مشكل فتبلوكى الرقم فواتساب:', blockError.message);
        }
    }
}

async function unblockUser(phone, sock = null) {
    blockedNumbers.delete(phone);
    blocklist.remove(phone);
    console.log(`✅ تفتح البلوك: ${phone}`);

    const socketToUse = sock || globalSock;
    if (socketToUse) {
        try {
            const jid = `${phone}@s.whatsapp.net`;
            await socketToUse.updateBlockStatus(jid, 'unblock');
            console.log(`✅ تفتح البلوك فواتساب: ${phone}`);
        } catch (unblockError) {
            console.error('❌ مشكل فتفتح البلوك فواتساب:', unblockError.message);
        }
    }
    return true;
}

async function updateUserActivity(phone, userName) {
    if (!isValidPhoneNumber(phone)) {
        console.log(`⚠️  ما حفظتش رقم ما صالح: ${phone}`);
        return;
    }
    users.update(phone, userName);
}

function checkFastSpam(phone) {
    if (isDeveloper(phone)) return 'ok';
    if (vipUsers.has(phone)) return 'ok';

    const now = Date.now();
    const fastWindow = SPAM_LIMITS.fastMessageWindow || 10000;
    const fastLimit = SPAM_LIMITS.fastMessages || 5;

    let tracker = fastMessageTracker.get(phone);
    if (!tracker) {
        tracker = { messages: [] };
        fastMessageTracker.set(phone, tracker);
    }

    tracker.messages = tracker.messages.filter(t => now - t < fastWindow);
    tracker.messages.push(now);

    if (tracker.messages.length >= fastLimit) {
        console.log(`🚨 سبيام سريع من ${phone}: ${tracker.messages.length} رسائل ف${fastWindow / 1000} ثواني - سيتم الطرد فوراً`);
        return 'block';
    }

    return 'ok';
}

function checkHourlySpam(phone) {
    if (isDeveloper(phone)) return 'ok';
    if (vipUsers.has(phone)) return 'ok';

    const now = Date.now();
    const oneHour = 60 * 60 * 1000;
    let tracker = hourlyMessageTracker.get(phone);
    if (!tracker) {
        tracker = { messages: [] };
        hourlyMessageTracker.set(phone, tracker);
    }
    tracker.messages = tracker.messages.filter(t => now - t < oneHour);
    tracker.messages.push(now);

    const hourlyLimit = SPAM_LIMITS.messagesPerHour || 25;
    if (tracker.messages.length > hourlyLimit) {
        return 'block';
    }
    return 'ok';
}

function checkDownloadSpam(phone) {
    if (isDeveloper(phone)) return 'ok';
    if (vipUsers.has(phone)) return 'ok';
    let tracker = downloadMessageTracker.get(phone);
    if (!tracker) return 'ok';
    const limits = getUserLimits(phone);
    if (tracker.count >= limits.maxConcurrentDownloads) {
        return 'block';
    }
    tracker.count++;
    downloadMessageTracker.set(phone, tracker);
    return 'ok';
}

function startDownloadTracking(phone) {
    downloadMessageTracker.set(phone, { count: 0 });
}

function stopDownloadTracking(phone) {
    downloadMessageTracker.delete(phone);
}

async function logDownload(userPhone, appId, appName, fileType, fileSize) {
    if (!isValidPhoneNumber(userPhone)) return;
    downloads.add(userPhone, appId, appName, fileType, fileSize);
}

async function getStats() {
    return downloads.getStats();
}

async function broadcastMessage(sock, message) {
    const usersData = users.getAll();
    let success = 0, failed = 0;
    for (const user of usersData.users) {
        try {
            if (!isValidPhoneNumber(user.phone)) {
                failed++;
                continue;
            }
            const jid = `${user.phone}@s.whatsapp.net`;
            await sock.sendMessage(jid, { text: `*مساج من المطور*\n\n${message}${POWERED_BY}` });
            success++;
            await new Promise(r => setTimeout(r, 3000 + Math.random() * 2000));
        } catch { failed++; }
    }
    return { success, failed };
}

async function getUserHistory(phone) {
    return downloads.getByUser(phone, 10).map(d => ({
        app_name: d.appName,
        file_type: d.fileType,
        created_at: d.createdAt
    }));
}

function formatFileSize(bytes) {
    if (bytes >= 1024 * 1024 * 1024) {
        return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    } else if (bytes >= 1024 * 1024) {
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    } else if (bytes >= 1024) {
        return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${bytes} bytes`;
}

function formatAppInfo(appDetails, fileType, fileSize) {
    let typeLabel = fileType.toUpperCase();
    if (fileType === 'zip') {
        typeLabel = 'ZIP (APK + OBB)';
    }
    const title = appDetails?.title || 'تطبيق';
    return `📱 *${title}*

◄ النوع: ${typeLabel}
◄ الحجم: ${formatFileSize(fileSize)}`;
}

function formatSearchResults(results, searchQuery = '') {
    let text = `نتائج البحث ديال *${searchQuery}*:\n\n`;

    results.forEach((app, index) => {
        const title = app?.title || app?.appId || 'تطبيق';
        text += `${index + 1}. ${title}\n`;
    });

    text += `\nشنو بغيتي ننزّل ليك؟ كتب الرقم.`;

    return text;
}

async function handleZArchiverDownload(sock, remoteJid, userId, senderPhone, msg, session) {
    session.isDownloading = true;
    startDownloadTracking(senderPhone);
    userSessions.set(userId, session);

    console.log(`✅ تنزيل ZArchiver (APK)`);

    await sock.sendMessage(remoteJid, { react: { text: '⏳', key: msg.key } });

    try {
        // جلب معلومات التطبيق من APKPure
        const appDetails = await getAppFromAPKPure(ZARCHIVER_PACKAGE) || { title: 'ZArchiver', appId: ZARCHIVER_PACKAGE };

        // إرسال الأيقونة كاستيكر
        if (appDetails.icon) {
            try {
                const { statusCode, body } = await request(appDetails.icon, {
                    method: 'GET',
                    headersTimeout: 10000,
                    bodyTimeout: 10000
                });
                if (statusCode === 200) {
                    const iconData = Buffer.from(await body.arrayBuffer());
                    const stickerBuffer = await sharp(iconData)
                        .resize(512, 512, {
                            fit: 'contain',
                            background: { r: 255, g: 255, b: 255, alpha: 0 }
                        })
                        .webp()
                        .toBuffer();
                    await sendBotMessage(sock, remoteJid, {
                        sticker: stickerBuffer
                    }, msg);
                }
            } catch (iconError) {
                console.log('⚠️ فشل إرسال الأيقونة:', iconError.message);
            }
        }

        await sock.sendMessage(remoteJid, { react: { text: '📥', key: msg.key } });

        // تنزيل ZArchiver كـ APK مباشرة (فرض APK وليس XAPK)
        const API_URL = process.env.API_URL || 'http://localhost:8000';

        console.log(`📥 كننزّل ZArchiver كـ APK...`);

        // استخدام endpoint مخصص يفرض APK
        const { statusCode, headers, body } = await request(`${API_URL}/download/${ZARCHIVER_PACKAGE}`, {
            method: 'GET',
            headersTimeout: 600000,
            bodyTimeout: 600000
        });

        if (statusCode !== 200) {
            throw new Error(`HTTP ${statusCode}`);
        }

        const chunks = [];
        for await (const chunk of body) {
            chunks.push(chunk);
        }

        const buffer = Buffer.concat(chunks);
        const fileSize = buffer.length;

        // فرض نوع الملف كـ APK
        const fileType = 'apk';
        const filename = `ZArchiver.${fileType}`;

        console.log(`✅ تّحمل ZArchiver: ${formatFileSize(fileSize)}`);

        if (buffer.length < 100000) {
            throw new Error('الملف المحمل صغير بزاف');
        }

        await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });

        await logDownload(senderPhone, ZARCHIVER_PACKAGE, 'ZArchiver', fileType, fileSize);
        recordDownload(senderPhone);

        let caption = formatAppInfo(appDetails, fileType, fileSize);
        caption += `\n◄ اسم الملف: ${filename}`;
        caption += `\n\nهذا تطبيق APK عادي، مايحتاجش ZArchiver باش تثبتو`;
        caption += POWERED_BY;

        await sendBotMessage(sock, remoteJid, {
            document: buffer,
            mimetype: 'application/vnd.android.package-archive',
            fileName: filename,
            caption: caption
        }, msg, { forward: true });

        await sendBotMessage(sock, remoteJid, { 
            text: `تابعني على انستجرام:\n${INSTAGRAM_URL}${POWERED_BY}` 
        }, msg, { forward: true, skipDelay: true });

        session.state = 'waiting_for_search';
        session.isDownloading = false;
        session.searchResults = [];
        stopDownloadTracking(senderPhone);
        userSessions.set(userId, session);

    } catch (error) {
        console.error('❌ مشكل فتنزيل ZArchiver:', error);
        await sendBotMessage(sock, remoteJid, { 
            text: `❌ وقع مشكل فتنزيل ZArchiver. عاود المحاولة.${POWERED_BY}` 
        }, msg);
        session.state = 'waiting_for_search';
        session.isDownloading = false;
        session.searchResults = [];
        stopDownloadTracking(senderPhone);
        userSessions.set(userId, session);
    }
}

const MIN_VALID_FILE_SIZE = 2 * 1024 * 1024;

async function downloadWithApkeepDirect(packageName, appTitle) {
    const API_URL = process.env.API_URL || 'http://localhost:8000';

    console.log(`📥 [apkeep] كننزّل باستعمال apkeep...`);

    try {
        const startTime = Date.now();
        const response = await axios({
            method: 'GET',
            url: `${API_URL}/download/${packageName}?force_apkeep=true`,
            responseType: 'arraybuffer',
            timeout: 900000,
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
            headers: {
                'X-Force-Apkeep': 'true'
            }
        });

        const buffer = Buffer.from(response.data);
        const fileSize = buffer.length;
        const fileType = response.headers['x-file-type'] || 'apk';
        const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(1);

        const safeTitle = appTitle.replace(/[^\w\s\u0600-\u06FF-]/g, '').trim();
        const filename = `${safeTitle}.${fileType}`;

        console.log(`\n✅ [apkeep] تّحمل: ${formatFileSize(fileSize)} في ${elapsedTime}s`);

        if (buffer.length >= MIN_VALID_FILE_SIZE) {
            return { buffer, filename, size: fileSize, fileType, source: 'apkeep' };
        }

        return null;
    } catch (error) {
        console.log(`❌ [apkeep] فشل: ${error.message}`);
        return null;
    }
}

async function downloadAPKToFile(packageName, appTitle) {
    const API_URL = process.env.API_URL || 'http://localhost:8000';
    const safeTitle = appTitle.replace(/[^\w\s\u0600-\u06FF-]/g, '').trim() || packageName;
    
    console.log(`📥 كننزّل مباشرة للقرص (للملفات الكبيرة)...`);
    
    const { pipeline } = await import('stream/promises');
    
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            console.log(`   محاولة ${attempt + 1}/3...`);
            const startTime = Date.now();
            
            const response = await axios({
                method: 'GET',
                url: `${API_URL}/download/${packageName}`,
                responseType: 'stream',
                timeout: 900000,
                maxContentLength: Infinity,
                maxBodyLength: Infinity
            });
            
            const fileType = response.headers['x-file-type'] || 'apk';
            const source = response.headers['x-source'] || 'apkpure';
            const totalSize = parseInt(response.headers['content-length'] || '0', 10);
            
            if (!fs.existsSync(TEMP_DIR)) {
                fs.mkdirSync(TEMP_DIR, { recursive: true });
            }
            
            const tempFilePath = path.join(TEMP_DIR, `${Date.now()}_${safeTitle}.${fileType}`);
            const writer = fs.createWriteStream(tempFilePath);
            
            let downloadedSize = 0;
            let lastLogTime = Date.now();
            
            response.data.on('data', (chunk) => {
                downloadedSize += chunk.length;
                const now = Date.now();
                if (now - lastLogTime > 2000) {
                    if (totalSize) {
                        const progress = ((downloadedSize / totalSize) * 100).toFixed(0);
                        process.stdout.write(`\r   ⬇️  ${(downloadedSize / 1024 / 1024).toFixed(1)}MB / ${(totalSize / 1024 / 1024).toFixed(1)}MB (${progress}%)`);
                    } else {
                        process.stdout.write(`\r   ⬇️  ${(downloadedSize / 1024 / 1024).toFixed(1)}MB تم تحميله...`);
                    }
                    lastLogTime = now;
                }
            });
            
            await pipeline(response.data, writer);
            
            const fileSize = fs.statSync(tempFilePath).size;
            const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(1);
            const speed = (fileSize / 1024 / 1024 / parseFloat(elapsedTime)).toFixed(2);
            
            console.log(`\n✅ تّحمل من ${source}: ${formatFileSize(fileSize)} | السرعة: ${speed} MB/s`);
            
            if (fileSize < MIN_VALID_FILE_SIZE) {
                try { fs.unlinkSync(tempFilePath); } catch(e) {}
                console.log(`⚠️ الملف أقل من 2MB - غادي نجرب apkeep...`);
                const apkeepResult = await downloadWithApkeepDirect(packageName, appTitle);
                if (apkeepResult) return apkeepResult;
            }
            
            return { 
                filePath: tempFilePath, 
                filename: `${safeTitle}.${fileType}`, 
                size: fileSize, 
                fileType,
                source,
                isFile: true
            };
            
        } catch (error) {
            console.log(`\n   ❌ المحاولة ${attempt + 1} فشلات: ${error.message}`);
            if (attempt === 2) {
                const apkeepResult = await downloadWithApkeepDirect(packageName, appTitle);
                if (apkeepResult) return apkeepResult;
            }
            if (attempt < 2) {
                await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
            }
        }
    }
    
    console.log(`📥 غادي نستعمل طريقة بديلة...`);
    return await downloadAPKStreamFallback(packageName, appTitle);
}

async function downloadAPKWithAxios(packageName, appTitle) {
    const API_URL = process.env.API_URL || 'http://localhost:8000';

    try {
        const headResponse = await axios.head(`${API_URL}/download/${packageName}`, { timeout: 30000 });
        const contentLength = parseInt(headResponse.headers['content-length'] || '0', 10);
        
        if (contentLength > MAX_WHATSAPP_SIZE) {
            console.log(`📦 الملف كبير (${formatFileSize(contentLength)}) - تحميل مباشر للقرص...`);
            return await downloadAPKToFile(packageName, appTitle);
        }
    } catch (e) {
        console.log(`⚠️ فشل فحص حجم الملف، سنستخدم الطريقة العادية`);
    }

    console.log(`📥 كننزّل باستعمال Axios (سريع)...`);

    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            console.log(`   محاولة ${attempt + 1}/3...`);

            const startTime = Date.now();
            const response = await axios({
                method: 'GET',
                url: `${API_URL}/download/${packageName}`,
                responseType: 'arraybuffer',
                timeout: 900000,
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
                onDownloadProgress: (progressEvent) => {
                    if (progressEvent.total) {
                        const progress = ((progressEvent.loaded / progressEvent.total) * 100).toFixed(0);
                        process.stdout.write(`\r   ⬇️  ${(progressEvent.loaded / 1024 / 1024).toFixed(1)}MB / ${(progressEvent.total / 1024 / 1024).toFixed(1)}MB (${progress}%)`);
                    } else {
                        process.stdout.write(`\r   ⬇️  ${(progressEvent.loaded / 1024 / 1024).toFixed(1)}MB تم تحميله...`);
                    }
                }
            });

            const buffer = Buffer.from(response.data);
            const fileSize = buffer.length;
            const fileType = response.headers['x-file-type'] || 'apk';
            const source = response.headers['x-source'] || 'apkpure';
            const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(1);
            const speed = (fileSize / 1024 / 1024 / parseFloat(elapsedTime)).toFixed(2);

            const safeTitle = appTitle.replace(/[^\w\s\u0600-\u06FF-]/g, '').trim();
            const filename = `${safeTitle}.${fileType}`;

            console.log(`\n✅ تّحمل من ${source}: ${formatFileSize(fileSize)} | السرعة: ${speed} MB/s`);

            if (fileSize < MIN_VALID_FILE_SIZE) {
                console.log(`⚠️ الملف أقل من 2MB (${formatFileSize(fileSize)}) - غادي نرجع ل apkeep...`);
                const apkeepResult = await downloadWithApkeepDirect(packageName, appTitle);
                if (apkeepResult) {
                    return apkeepResult;
                }
                console.log(`⚠️ apkeep ما نفعش - غادي نرجع الملف الصغير`);
            }

            if (buffer.length > 100000) {
                return { buffer, filename, size: fileSize, fileType };
            }

            throw new Error('الملف المحمل صغير بزاف');

        } catch (error) {
            console.log(`\n   ❌ المحاولة ${attempt + 1} فشلات: ${error.message}`);

            if (attempt === 2) {
                console.log(`📥 غادي نجرب apkeep كـ fallback...`);
                const apkeepResult = await downloadWithApkeepDirect(packageName, appTitle);
                if (apkeepResult) {
                    return apkeepResult;
                }
            }

            if (error.message.includes('maxContentLength') || error.message.includes('FILE_TOO_LARGE')) {
                break;
            }
            if (attempt < 2) {
                await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
            }
        }
    }

    console.log(`📥 غادي نستعمل طريقة بديلة...`);
    return await downloadAPKStreamFallback(packageName, appTitle);
}

async function downloadAPKStreamFallback(packageName, appTitle) {
    return new Promise((resolve) => {
        const pythonScript = path.join(__dirname, 'scrap.py');
        const pythonProcess = spawn('python3', [pythonScript, packageName]);
        let output = '', error = '';
        pythonProcess.stdout.on('data', (data) => { output += data.toString(); });
        pythonProcess.stderr.on('data', (data) => { error += data.toString(); });
        pythonProcess.on('close', (code) => {
            if (code === 0 && output.trim()) {
                const filePath = output.trim();
                if (fs.existsSync(filePath)) {
                    const buffer = fs.readFileSync(filePath);
                    const filename = path.basename(filePath);
                    const fileSize = fs.statSync(filePath).size;
                    fs.unlinkSync(filePath);
                    const fileType = filename.toLowerCase().endsWith('.xapk') ? 'xapk' : 'apk';
                    const safeTitle = appTitle.replace(/[^\w\s\u0600-\u06FF-]/g, '').trim();
                    resolve({ buffer, filename: `${safeTitle}.${fileType}`, size: fileSize, fileType });
                } else {
                    resolve(null);
                }
            } else {
                resolve(null);
            }
        });
        pythonProcess.on('error', () => resolve(null));
    });
}

async function processRequest(sock, from, task) {
    // Use global semaphore to limit total concurrent requests
    await globalRequestSemaphore.acquire();
    
    try {
        let queue = requestQueue.get(from);
        if (!queue) {
            queue = { processing: false, tasks: [] };
            requestQueue.set(from, queue);
        }
        queue.tasks.push(task);
        if (queue.processing) {
            globalRequestSemaphore.release();
            return;
        }
        queue.processing = true;
        
        while (queue.tasks.length > 0) {
            const currentTask = queue.tasks.shift();
            try { 
                await currentTask(); 
            } catch (error) { 
                console.error('غلطة فمعالجة الطلب:', error.message); 
            }
        }
        queue.processing = false;
    } finally {
        globalRequestSemaphore.release();
    }
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('session');

    const silentLogger = pino({ 
        level: 'silent',
        hooks: {
            logMethod(inputArgs, method) {
                return method.apply(this, inputArgs);
            }
        }
    });

    const sock = makeWASocket({
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, silentLogger)
        },
        logger: silentLogger,
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome'),
        
        // إعدادات محسّنة للسرعة والاستقرار
        msgRetryCounterCache,
        connectTimeoutMs: 120000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 20000,
        emitOwnEvents: false,
        fireInitQueries: true,
        generateHighQualityLinkPreview: false,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        retryRequestDelayMs: 500,
        maxMsgRetryCount: 10,
        qrTimeout: 60000,
        
        // تصحيح الرسائل للأزرار
        patchMessageBeforeSending: (message) => {
            const requiresPatch = !!(message.interactiveResponse || message.buttonsMessage || message.templateMessage || message.listMessage);
            if (requiresPatch) {
                message = {
                    viewOnceMessage: {
                        message: {
                            messageContextInfo: {
                                deviceListMetadataVersion: 2,
                                deviceListMetadata: {}
                            },
                            ...message
                        }
                    }
                };
            }
            return message;
        },
        
        // تخزين مؤقت للمجموعات
        cachedGroupMetadata: async (jid) => {
            const cached = groupMetadataCache.get(jid);
            if (cached && Date.now() - cached.timestamp < 300000) {
                return cached.data;
            }
            return null;
        },
        getMessage: async (key) => {
            return getStoredMessage(key);
        }
    });

    globalSock = sock;
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        for (const msg of messages) {
            if (msg.key && msg.message) {
                storeMessage(msg.key, msg.message);
            }
        }
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error instanceof Boom) 
                ? lastDisconnect.error.output.statusCode : 500;

            let shouldReconnect = true;
            let reasonMsg = '';

            switch (statusCode) {
                case DisconnectReason.loggedOut:
                    shouldReconnect = false;
                    reasonMsg = 'تسجيل الخروج - امسح الجلسة وسكان QR من جديد';
                    break;
                case DisconnectReason.connectionClosed:
                    reasonMsg = 'الاتصال مسكر';
                    break;
                case DisconnectReason.connectionLost:
                    reasonMsg = 'ضاع الاتصال';
                    break;
                case DisconnectReason.connectionReplaced:
                    shouldReconnect = false;
                    reasonMsg = 'الاتصال تعوض بجهاز آخر';
                    break;
                case DisconnectReason.timedOut:
                    reasonMsg = 'انتهى الوقت';
                    break;
                case DisconnectReason.restartRequired:
                    reasonMsg = 'خاص إعادة التشغيل';
                    break;
                case 428:
                    reasonMsg = 'انتهت صلاحية الجلسة (24 ساعة)';
                    break;
                case 401:
                    shouldReconnect = false;
                    reasonMsg = 'غير مصرح - سكان QR من جديد';
                    break;
                case 403:
                    shouldReconnect = false;
                    reasonMsg = 'ممنوع - الحساب محظور';
                    break;
                case 515:
                    reasonMsg = 'خاص إعادة التشغيل';
                    break;
                case 405:
                    if (pairingCodeRequested) {
                        reasonMsg = 'كنتسنى كود الاقتران - عندك 3 دقائق';
                        shouldReconnect = true;
                        console.log('⏳ كنتسنى تدخل كود الاقتران... غادي نعاود الاتصال');
                    } else {
                        reasonMsg = 'الجلسة فاسدة - غادي نمسح الجلسة ونعاود';
                        try {
                            const sessionDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'session');
                            if (fs.existsSync(sessionDir)) {
                                fs.rmSync(sessionDir, { recursive: true, force: true });
                                fs.mkdirSync(sessionDir, { recursive: true });
                                console.log('🗑️ مسحت الجلسة القديمة');
                            }
                        } catch (e) {
                            console.error('❌ مشكل فمسح الجلسة:', e.message);
                        }
                    }
                    break;
                default:
                    reasonMsg = `كود الخطأ: ${statusCode}`;
            }

            console.log(`❌ الاتصال تقطع - ${reasonMsg}`);

            if (keepAliveInterval) {
                clearInterval(keepAliveInterval);
                keepAliveInterval = null;
            }
            if (presenceInterval) {
                clearInterval(presenceInterval);
                presenceInterval = null;
            }

            if (shouldReconnect && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                reconnectAttempts++;
                const delay = Math.min(BASE_RECONNECT_DELAY * Math.pow(1.5, reconnectAttempts - 1), 60000);
                console.log(`⏳ محاولة ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} - نعاود من بعد ${Math.round(delay/1000)} ثانية...`);
                pairingCodeRequested = false;
                setTimeout(() => connectToWhatsApp(), delay);
            } else if (!shouldReconnect) {
                console.log('🛑 ماغاديش نعاود الاتصال - ' + reasonMsg);
                reconnectAttempts = 0;
            } else {
                console.log('🛑 وصلت للحد الأقصى ديال المحاولات. عاود تشغيل البوت يدوياً.');
                reconnectAttempts = 0;
            }
        } else if (connection === 'open') {
            reconnectAttempts = 0;
            console.log('✅ تّصلت بواتساب بنجاح!');
            console.log('🤖 بوت Omar AI واجد');
            
            if (sock.user && sock.user.id) {
                botPhoneNumber = sock.user.id.split(':')[0].split('@')[0].replace(/\D/g, '');
                console.log(`📱 نمرة البوت: ${botPhoneNumber}`);
            }
            
            console.log(`👨‍💻 نمرة المطور: ${DEVELOPER_PHONES.join(', ')}`);
            pairingCodeRequested = false;

            try { await sock.sendPresenceUpdate(botPresenceMode); } catch {}

            if (presenceInterval) clearInterval(presenceInterval);
            const presenceDelay = 45000 + Math.floor(Math.random() * 30000);
            presenceInterval = setInterval(async () => {
                try { await sock.sendPresenceUpdate(botPresenceMode); } catch {}
            }, presenceDelay);

            if (keepAliveInterval) clearInterval(keepAliveInterval);
            const keepAliveDelay = 60000 + Math.floor(Math.random() * 30000);
            keepAliveInterval = setInterval(async () => {
                try {
                    if (sock.user) {
                        await sock.query({tag: 'iq', attrs: {type: 'get', to: '@s.whatsapp.net'}, content: [{tag: 'ping', attrs: {}}]});
                    }
                } catch {}
            }, keepAliveDelay);

            await new Promise(r => setTimeout(r, 3000 + Math.random() * 2000));
            await setBotProfile(sock);
        } else if (connection === 'connecting') {
            console.log('🔗 كنحاول نتصل بواتساب...');
            if (!sock.authState.creds.registered && !pairingCodeRequested) {
                pairingCodeRequested = true;
                const phoneNumber = process.env.PHONE_NUMBER?.replace(/[^0-9]/g, '');
                if (!phoneNumber) {
                    console.log('⚠️  ماعنديش PHONE_NUMBER - ماغاديش نطلب كود الاقتران');
                    pairingCodeRequested = false;
                    return;
                }
                console.log(`📞 رقم الهاتف: ${phoneNumber}`);
                setTimeout(async () => {
                    try {
                        console.log('⏳ كنطلب كود الاقتران...');
                        const code = await sock.requestPairingCode(phoneNumber);
                        console.log('\n╔════════════════════════════════════╗');
                        console.log('║     📱 كود الاقتران ديالك:        ║');
                        console.log(`║          ${code}                  ║`);
                        console.log('╚════════════════════════════════════╝\n');
                        console.log('⏳ عندك 3 دقائق باش تدخل الكود فواتساب');
                        console.log('📲 افتح واتساب > الأجهزة المرتبطة > ربط جهاز > أدخل الكود');
                        fs.writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'pairing_code.txt'), JSON.stringify({ code, timestamp: Date.now() }));
                    } catch (error) {
                        console.error('❌ مشكل فطلب كود الاقتران:', error.message);
                        if (error.message?.includes('Precondition') || error.message?.includes('405')) {
                            console.log('🔄 غادي نعاود المحاولة...');
                        }
                        pairingCodeRequested = false;
                    }
                }, 5000);
            }
        }
    });

    sock.ev.on('call', async (callData) => {
        try {
            for (const call of callData) {
                if (call.status === 'offer') {
                    const callerPhone = getSenderPhone(call.from, null);
                    if (isDeveloper(callerPhone)) {
                        console.log(`📞 مكالمة من المطور - ما غاديش نبلوك`);
                        return;
                    }
                    console.log(`📞 مكالمة جاية من: ${callerPhone} - غادي نبلوك`);
                    try {
                        await sock.rejectCall(call.id, call.from);
                        await blockUserWithNotification(sock, callerPhone, 'بلوك أوتوماتيكي بسبب المكالمة');

                        await notifyDeveloper(sock, 'call', {
                            phone: callerPhone
                        });

                        const callBlockMessage = `⛔ *شنو هاد التصرف؟!*

📞 واش نتا مجنون؟ المكالمات ممنوعة هنا!

🤖 أنا Omar AI، بوت ذكي ماشي إنسان باش تتصل بيا!
🚫 تبلوكيتي نهائياً بسبب هاد الحركة.

${INSTAGRAM_URL}${POWERED_BY}`;

                        await sendBotMessage(sock, call.from, { text: callBlockMessage });
                    } catch (error) {
                        console.error('❌ مشكل فرفض المكالمة:', error.message);
                        await notifyDeveloper(sock, 'error', {
                            phone: callerPhone,
                            error: error.message,
                            location: 'call handler'
                        });
                    }
                }
            }
        } catch (error) {
            console.error('❌ خطأ في معالجة المكالمة:', error.message);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        try {
            const msg = messages[0];
            if (!msg.message) return;

            // تجاهل رسائل البوت نفسه
            if (msg.key.fromMe) return;

            // منع معالجة الرسالة نفسها مرتين
            const msgId = msg.key.id;
            if (messageResponseCache.has(msgId)) {
                return;
            }
            messageResponseCache.set(msgId, true);

            // تجاهل الرسائل القديمة (أكثر من 60 ثانية)
            const messageTimestamp = msg.messageTimestamp;
            const now = Math.floor(Date.now() / 1000);
            if (messageTimestamp && (now - messageTimestamp) > 60) {
                console.log('⏰ تجاهل رسالة قديمة');
                return;
            }

            const messageKeys = Object.keys(msg.message);
            const supportedTypes = ['conversation', 'extendedTextMessage', 'imageMessage', 'videoMessage', 'documentMessage', 'interactiveResponseMessage', 'listResponseMessage', 'buttonsResponseMessage'];
            
            let messageType = messageKeys.find(key => supportedTypes.includes(key)) || messageKeys[0];
            console.log(`📩 نوع الرسالة الواردة: ${messageType}`);
            
            if (!supportedTypes.includes(messageType)) {
                console.log(`⚠️ نوع غير مدعوم: ${messageType} | المفاتيح: ${messageKeys.join(', ')}`);
                return;
            }

            const remoteJid = msg.key.remoteJid;
            const participant = msg.key.participant;
            const userId = getUserId(remoteJid, participant);
            const senderPhone = extractPhoneFromMessage(msg);

            let text = '';
            let mediaData = null;

            if (messageType === 'conversation') {
                text = msg.message.conversation || '';
            } else if (messageType === 'extendedTextMessage') {
                text = msg.message.extendedTextMessage?.text || '';
            } else if (messageType === 'imageMessage') {
                text = msg.message.imageMessage?.caption || '';
                try {
                    const buffer = await downloadMediaMessage(msg, 'buffer', {});
                    mediaData = {
                        base64: buffer.toString('base64'),
                        mimeType: msg.message.imageMessage.mimetype || 'image/jpeg'
                    };
                    console.log(`📸 تم تحميل صورة: ${mediaData.mimeType}, الحجم: ${buffer.length} bytes`);
                } catch (e) {
                    console.error('❌ فشل تحميل الصورة:', e.message);
                }
            } else if (messageType === 'videoMessage') {
                text = msg.message.videoMessage?.caption || '';
            } else if (messageType === 'documentMessage') {
                text = msg.message.documentMessage?.caption || '';
                const mimeType = msg.message.documentMessage?.mimetype || '';
                if (mimeType.startsWith('image/')) {
                    try {
                        const buffer = await downloadMediaMessage(msg, 'buffer', {});
                        mediaData = {
                            base64: buffer.toString('base64'),
                            mimeType: mimeType
                        };
                        console.log(`📄 تم تحميل صورة من document: ${mediaData.mimeType}, الحجم: ${buffer.length} bytes`);
                    } catch (e) {
                        console.error('❌ فشل تحميل الصورة من document:', e.message);
                    }
                }
            } else if (messageType === 'interactiveResponseMessage' || messageType === 'listResponseMessage' || messageType === 'buttonsResponseMessage') {
                console.log(`🔍 نوع الرسالة التفاعلية: ${messageType}`);
                console.log(`🔍 محتوى الرسالة:`, JSON.stringify(msg.message, null, 2));
                const interactiveData = parseInteractiveResponse(msg);
                console.log(`🔍 البيانات المحللة:`, interactiveData);
                if (interactiveData) {
                    text = interactiveData.id || interactiveData.text || '';
                    console.log(`🎮 رد تفاعلي: ${text}`);
                } else {
                    console.log(`⚠️ فشل تحليل الرد التفاعلي`);
                }
            }

            text = text.trim();
            if (!text && !mediaData) return;

            const userName = msg.pushName || 'مستخدم';
            const isAdmin = isDeveloper(senderPhone);

            console.log(`📨 رسالة من: ${senderPhone} | مطور: ${isAdmin} | النص: ${text.substring(0, 50)}`);

            const isBlacklisted = await checkBlacklist(senderPhone);
            if (isBlacklisted && !isAdmin) return;

            const isGroup = remoteJid.endsWith('@g.us');
            const senderJid = participant || `${senderPhone}@s.whatsapp.net`;
            
            // Check bot mode - admin commands bypass this check
            if (!shouldProcessMessage(isGroup, isAdmin)) {
                // إذا كان الوضع groups والرسالة خاصة - أرسل رسالة توضيحية بدون حظر
                if (BOT_MODE === 'groups' && !isGroup) {
                    const groupModeMessage = `🤖 *البوت يعمل في المجموعات فقط*

مرحباً! البوت حالياً متاح فقط داخل المجموعات.

📲 *للاستخدام:*
• انضم لمجموعة فيها البوت
• أو أضف البوت لمجموعتك

${INSTAGRAM_URL}${POWERED_BY}`;
                    await sendBotMessage(sock, remoteJid, { text: groupModeMessage }, msg, { skipDelay: true });
                    console.log(`📢 رسالة خاصة من ${senderPhone} - تم إرسال رسالة وضع المجموعات`);
                } else {
                    console.log(`🔇 تم تجاهل الرسالة - البوت يعمل في الخاص فقط`);
                }
                return;
            }
            
            if (!isGroup && !isAdmin) {
                const antiPrivateResult = await handleAntiPrivate(sock, remoteJid, senderPhone, isAdmin);
                if (antiPrivateResult.action === 'block_private_soft' || antiPrivateResult.action === 'block_private') {
                    await processAntiPrivateAction(sock, remoteJid, senderPhone, antiPrivateResult);
                    console.log(`🚫 رسالة خاصة من ${senderPhone} - تم حظره في الخاص فقط (يمكنه استخدام البوت في المجموعات)`);
                    return;
                } else if (antiPrivateResult.action === 'ignore_private') {
                    console.log(`🔇 رسالة خاصة من ${senderPhone} - محظور سابقاً في الخاص، تم تجاهلها`);
                    return;
                } else if (antiPrivateResult.action === 'reply_private') {
                    await sendBotMessage(sock, remoteJid, { text: `${antiPrivateResult.message}${POWERED_BY}` }, msg);
                    console.log(`📵 رسالة خاصة من ${senderPhone} - تم إرسال رسالة المجموعة`);
                    return;
                }
            }

            if (text && await handleCommandPlugin(sock, remoteJid, text, msg, senderPhone)) {
                console.log(`✅ تم معالجة أمر من ${senderPhone}`);
                return;
            }
            
            if (isGroup && !isAdmin && text) {
                const antiLinkResult = await handleAntiLink(sock, msg, text, senderJid, remoteJid, senderPhone);
                if (antiLinkResult.action === 'kick') {
                    const kicked = await processGroupAction(sock, remoteJid, senderJid, senderPhone, antiLinkResult);
                    if (kicked) {
                        console.log(`🔗 تم طرد ${senderPhone} من المجموعة: ${antiLinkResult.reason}`);
                        return;
                    }
                }

                const antiBadWordsResult = await handleAntiBadWords(sock, msg, text, senderJid, remoteJid, senderPhone, BAD_WORDS_CONFIG);
                if (antiBadWordsResult.action === 'kick') {
                    const kicked = await processGroupAction(sock, remoteJid, senderJid, senderPhone, antiBadWordsResult);
                    if (kicked) {
                        console.log(`🚫 تم طرد ${senderPhone} من المجموعة: ${antiBadWordsResult.reason}`);
                        return;
                    }
                } else if (antiBadWordsResult.action === 'warn') {
                    await sendBotMessage(sock, remoteJid, { 
                        text: antiBadWordsResult.message,
                        mentions: [senderJid]
                    }, msg);
                    return;
                }
                
                // كشف السبام السريع في المجموعات
                const fastSpamStatus = checkFastSpam(senderPhone);
                if (fastSpamStatus === 'block') {
                    const isBotAdminStatus = await isBotAdmin(sock, remoteJid);
                    if (isBotAdminStatus) {
                        try {
                            await sock.sendMessage(remoteJid, {
                                text: `*⛔ تم طردك من المجموعة*\n\n❌ سبيام رسائل سريعة\n🚫 إرسال رسائل متتابعة ممنوع\n\n@${senderPhone}`,
                                mentions: [senderJid]
                            });
                            await sock.groupParticipantsUpdate(remoteJid, [senderJid], 'remove');
                            console.log(`🚨 تم طرد ${senderPhone} من المجموعة بسبب سبيام سريع`);
                            return;
                        } catch (kickError) {
                            console.error('❌ فشل طرد السبيامر:', kickError.message);
                        }
                    }
                }
                
                // مراقبة Gemini الذكية للمحتوى المخالف
                if (text.length > 5) {
                    try {
                        const moderationResult = await moderateGroupMessage(text, userName);
                        if (moderationResult.violation && moderationResult.severity === 'high') {
                            const isBotAdminStatus = await isBotAdmin(sock, remoteJid);
                            if (isBotAdminStatus) {
                                try {
                                    await sock.sendMessage(remoteJid, { delete: msg.key });
                                } catch (delErr) {}
                                
                                await sock.sendMessage(remoteJid, {
                                    text: `*⛔ تم طردك من المجموعة*\n\n❌ ${moderationResult.reason || 'انتهاك قوانين المجموعة'}\n🤖 تم الكشف بواسطة الذكاء الاصطناعي\n\n@${senderPhone}`,
                                    mentions: [senderJid]
                                });
                                await sock.groupParticipantsUpdate(remoteJid, [senderJid], 'remove');
                                console.log(`🤖 Gemini طرد ${senderPhone}: ${moderationResult.reason}`);
                                
                                await notifyDeveloper(sock, 'badWords', {
                                    phone: senderPhone,
                                    userName: userName,
                                    message: text,
                                    words: [moderationResult.reason],
                                    warningCount: 'AI Detection'
                                });
                                return;
                            }
                        }
                    } catch (modError) {
                        console.log('⚠️ خطأ في مراقبة Gemini:', modError.message);
                    }
                }
            }

            if (!isAdmin && text && !isGroup) {
                const badWordsHandled = await handleBadWordsMessage(sock, remoteJid, senderPhone, userName, text, msg);
                if (badWordsHandled) return;
            }

            let session = userSessions.get(userId);
            if (session && session.isDownloading && !isAdmin) {
                const downloadSpamStatus = checkDownloadSpam(senderPhone);
                if (downloadSpamStatus === 'block') {
                    stopDownloadTracking(senderPhone);
                    await blockUserWithNotification(sock, senderPhone, 'بلوك بسبب تجاوز حد التنزيلات (10)', userName);

                    await notifyDeveloper(sock, 'spam', {
                        phone: senderPhone,
                        userName: userName,
                        spamType: 'تجاوز حد التنزيلات (10 متتابعة)'
                    });

                    const downloadSpamMessage = `⛔ *علاش كتسبيمي عليا؟!*

❌ واش باغي تخربق البوت؟ 10 تحميلات متتابعة بزاف!

🤖 أنا Omar AI وماشي مكينة فتسبيمي!
📊 الحد: 3 تحميلات متتابعة ماشي 10!

💡 المرة الجاية صبر شوية بين كل طلب.
🚫 تبلوكيتي نهائياً!${POWERED_BY}`;

                    await sendBotMessage(sock, remoteJid, { text: downloadSpamMessage }, msg);
                    return;
                }
                await sendBotMessage(sock, remoteJid, { 
                    text: `⏳ شوية صبر، غانرسل ليك التطبيق...${POWERED_BY}`
                }, msg);
                return;
            }

            if (!isAdmin) {
                const hourlyStatus = checkHourlySpam(senderPhone);
                if (hourlyStatus === 'block') {
                    await blockUserWithNotification(sock, senderPhone, 'بلوك بسبب تجاوز حد الرسائل (25/ساعة)', userName);

                    await notifyDeveloper(sock, 'spam', {
                        phone: senderPhone,
                        userName: userName,
                        spamType: 'تجاوز حد الرسائل (25/ساعة)'
                    });

                    const hourlySpamMessage = `⛔ *بركا من السبيام!*

❌ 25 رسالة فساعة وحدة؟! واش عندك شي مشكل؟

🤖 أنا Omar AI، بوت ذكي ماشي روبوت فتسبيمي!
📊 الحد: 25 رسالة فالساعة

💡 إلى بغيتي توضح راسك، تواصل مع المطور باحترام.
🚫 تبلوكيتي نهائياً!${POWERED_BY}`;

                    await sendBotMessage(sock, remoteJid, { text: hourlySpamMessage }, msg);
                    return;
                }
            }

            await updateUserActivity(senderPhone, userName);

            await processRequest(sock, userId, async () => {
                try {
                    await new Promise(r => setTimeout(r, 50)); // Small delay before processing
                    await handleMessage(sock, remoteJid, userId, senderPhone, text, msg, userName, isAdmin, mediaData);
                } catch (error) {
                    console.error('❌ مشكل فمعالجة الرسالة:', error);
                    try {
                        await sendBotMessage(sock, remoteJid, { text: `❌ وقع مشكل. عاود المحاولة.${POWERED_BY}` }, msg);
                    } catch (e) {
                        console.error('❌ فشل إرسال رسالة الخطأ:', e.message);
                    }
                }
            });
        } catch (error) {
            console.error('❌ خطأ عام في معالجة الرسالة:', error.message);
        }
    });

    return sock;
}

async function handleMessage(sock, remoteJid, userId, senderPhone, text, msg, userName, isAdmin, mediaData = null) {
    const isGroup = remoteJid.endsWith('@g.us');
    const senderJid = senderPhone + '@s.whatsapp.net';
    let session = userSessions.get(userId);
    const isNewUser = !session;
    if (!session) {
        session = { state: 'idle', searchResults: [], isDownloading: false, lastListMessageKey: null, firstTime: true };
        userSessions.set(userId, session);
    }

    const lowerText = text.toLowerCase().trim();

    if (text === VIP_PASSWORD) {
        vipUsers.add(senderPhone);
        stopDownloadTracking(senderPhone);
        await sendBotMessage(sock, remoteJid, { 
            text: `🌟 *VIP تَفَعّل*

◄ تنزيلات بلا حدود
◄ سرعة مزيانة
◄ أولوية فالطلبات${POWERED_BY}`
        }, msg);
        return;
    }

    if (lowerText === 'games' || lowerText === 'العاب' || lowerText === 'ألعاب' || lowerText === '/games') {
        console.log(`🎮 طلب قائمة الألعاب من: ${senderPhone}`);
        session.state = 'waiting_for_game';
        userSessions.set(userId, session);
        await sendGamesListMenu(sock, remoteJid, msg, POWERED_BY);
        return;
    }

    if (text.startsWith('game_') || (session.state === 'waiting_for_game' && !isNaN(parseInt(text)))) {
        let gameId = text;
        if (!isNaN(parseInt(text))) {
            const gameIndex = parseInt(text) - 1;
            if (gameIndex >= 0 && gameIndex < GAMES_LIST.length) {
                gameId = GAMES_LIST[gameIndex].id;
            }
        }
        
        const selectedGame = GAMES_LIST.find(g => g.id === gameId);
        if (selectedGame) {
            console.log(`🎮 اختار لعبة: ${selectedGame.title}`);
            session.state = `playing_${gameId}`;
            session.gameData = { game: selectedGame, started: Date.now() };
            userSessions.set(userId, session);
            
            await handleGameStart(sock, remoteJid, msg, selectedGame, session, userId, senderPhone);
            return;
        }
        
        session.state = 'idle';
        userSessions.set(userId, session);
    }

    // التحقق من الروابط أولاً قبل أي شيء آخر
    const extractedUrl = extractUrl(text);
    if (extractedUrl) {
        const handled = await handlePluginUrl(sock, remoteJid, extractedUrl, msg, senderPhone);
        if (handled) {
            return;
        }
    }

    if (lowerText === 'zarchiver' || lowerText === 'زارشيفر') {
        session.state = 'waiting_for_selection';
        session.searchResults = [{ title: 'ZArchiver', appId: ZARCHIVER_PACKAGE, developer: 'ZDevs', score: 4.5, index: 1 }];
        userSessions.set(userId, session);

        await sendBotMessage(sock, remoteJid, { 
            text: `📦 كننزّل ZArchiver...${POWERED_BY}`
        }, msg);

        // تنزيل ZArchiver مباشرة كـ APK (وليس XAPK)
        await handleZArchiverDownload(sock, remoteJid, userId, senderPhone, msg, session);
        return;
    }

    if (isNewUser && session.firstTime && !isGroup) {
        session.firstTime = false;

        const welcomeText = `*مرحبا بك في بوت Omar AI* 🤖

📱 *تحميل التطبيقات:*
صيفط اسم التطبيق وأنا نجيبو ليك

🎬 *تحميل الفيديوهات:*
Facebook • Instagram • TikTok
YouTube • Twitter • Pinterest

📁 *تحميل الملفات:*
Mediafire • Google Drive

💡 غير صيفط الرابط أو اسم التطبيق${POWERED_BY}`;

        // Send bot profile picture with welcome
        const botImage = await downloadBotProfileImage();
        if (botImage) {
            try {
                await sendBotMessage(sock, remoteJid, {
                    image: botImage,
                    caption: welcomeText
                }, msg);
            } catch (imgError) {
                await sendBotMessage(sock, remoteJid, { text: welcomeText }, msg);
            }
        } else {
            await sendBotMessage(sock, remoteJid, { text: welcomeText }, msg);
        }

        // Don't search on first message - just show welcome
        return;
    }

    if (isAdmin) {
        console.log(`🔧 أمر المطور: ${text}`);

        if (text === '/stats' || text.startsWith('/stats')) {
            const stats = await getStats();
            if (stats) {
                let statsMsg = `📊 *احصائيات البوت*

◄ المستخدمين: ${stats.totalUsers}
◄ التنزيلات: ${stats.totalDownloads}
◄ تنزيلات اليوم: ${stats.todayDownloads}
◄ الحجم الكلي: ${(stats.totalSize / (1024 * 1024 * 1024)).toFixed(2)} GB
◄ المحظورين: ${stats.blockedUsers}

🔥 *أكثر التطبيقات تنزيلاً:*`;
                stats.topApps.forEach((app, i) => { statsMsg += `\n${i + 1}◄ ${app.app_name} (${app.count})`; });
                statsMsg += POWERED_BY;
                await sendBotMessage(sock, remoteJid, { text: statsMsg }, msg);
            } else {
                await sendBotMessage(sock, remoteJid, { text: `❌ قاعدة البيانات مش موصولة${POWERED_BY}` }, msg);
            }
            return;
        }

        if (text.startsWith('/mode ')) {
            const newMode = text.replace('/mode ', '').trim().toLowerCase();
            if (setBotMode(newMode)) {
                const modeNames = {
                    'all': 'الجروبات والخاص',
                    'groups': 'الجروبات فقط',
                    'private': 'الخاص فقط',
                    'dev': 'المطور فقط'
                };
                await sendBotMessage(sock, remoteJid, { 
                    text: `✅ *تم تغيير وضع البوت*\n\n◄ الوضع الجديد: *${modeNames[newMode]}*${POWERED_BY}` 
                }, msg);
            } else {
                await sendBotMessage(sock, remoteJid, { 
                    text: `❌ وضع غير صحيح\n\nالأوضاع المتاحة:\n◄ /mode all - الجروبات والخاص\n◄ /mode groups - الجروبات فقط\n◄ /mode private - الخاص فقط\n◄ /mode dev - المطور فقط${POWERED_BY}` 
                }, msg);
            }
            return;
        }

        if (text === '/mode') {
            const currentMode = DEV_MODE ? 'dev' : getBotMode();
            const modeNames = {
                'all': 'الجروبات والخاص',
                'groups': 'الجروبات فقط',
                'private': 'الخاص فقط',
                'dev': 'المطور فقط'
            };
            await sendBotMessage(sock, remoteJid, { 
                text: `⚙️ *وضع البوت الحالي*\n\n◄ الوضع: *${modeNames[currentMode]}*\n\n*تغيير الوضع:*\n◄ /mode all - الجروبات والخاص\n◄ /mode groups - الجروبات فقط\n◄ /mode private - الخاص فقط\n◄ /mode dev - المطور فقط${POWERED_BY}` 
            }, msg);
            return;
        }

        if (text.startsWith('/broadcast ')) {
            const message = text.replace('/broadcast ', '').trim();
            if (message) {
                await sendBotMessage(sock, remoteJid, { text: `كنرسِل الرسالة...${POWERED_BY}` }, msg);
                const result = await broadcastMessage(sock, message);
                await sendBotMessage(sock, remoteJid, { text: `تْرسلات\n\nنجح: ${result.success}\nفشل: ${result.failed}${POWERED_BY}` }, msg);
            }
            return;
        }


        if (text === '/block' || text.startsWith('/block ')) {
            let numberToBlock = text.replace('/block ', '').trim();
            
            if (text === '/block' || !numberToBlock) {
                const quotedMsg = msg?.message?.extendedTextMessage?.contextInfo;
                if (quotedMsg && quotedMsg.participant) {
                    numberToBlock = quotedMsg.participant.replace('@s.whatsapp.net', '').replace('@lid', '');
                } else if (quotedMsg && quotedMsg.remoteJid) {
                    numberToBlock = quotedMsg.remoteJid.replace('@s.whatsapp.net', '').replace('@lid', '');
                }
            }
            
            if (!numberToBlock) {
                await sendBotMessage(sock, remoteJid, { 
                    text: `استعمل الأمر هكذا:\n1. /block [رقم]\n2. أو رد على رسالة المستخدم واكتب /block${POWERED_BY}` 
                }, msg);
                return;
            }
            
            const cleanNumber = numberToBlock.replace(/\D/g, '');
            await blockUser(cleanNumber, 'بلوك يدوي من المطور', sock);
            await sendBotMessage(sock, remoteJid, { text: `تبلوكى ${cleanNumber}${POWERED_BY}` }, msg);
            return;
        }
        
        if (text === '/unblock' || text.startsWith('/unblock ')) {
            let numberToUnblock = text.replace('/unblock ', '').trim();
            
            if (text === '/unblock' || !numberToUnblock) {
                const quotedMsg = msg?.message?.extendedTextMessage?.contextInfo;
                if (quotedMsg && quotedMsg.participant) {
                    numberToUnblock = quotedMsg.participant.replace('@s.whatsapp.net', '').replace('@lid', '');
                }
            }
            
            if (!numberToUnblock) {
                await sendBotMessage(sock, remoteJid, { 
                    text: `استعمل الأمر هكذا:\n1. /unblock [رقم]\n2. أو رد على رسالة واكتب /unblock${POWERED_BY}` 
                }, msg);
                return;
            }
            
            const cleanNumber = numberToUnblock.replace(/\D/g, '');
            const success = await unblockUser(cleanNumber, sock);
            await sendBotMessage(sock, remoteJid, { text: success ? `تحيّد البلوك على ${cleanNumber}${POWERED_BY}` : `ماقديتش نحيد البلوك${POWERED_BY}` }, msg);
            return;
        }

        if (text === '/offline') {
            botPresenceMode = 'unavailable';
            try { 
                await sock.sendPresenceUpdate(botPresenceMode); 
                await sendBotMessage(sock, remoteJid, { text: `🔴 *البوت ولى Offline*\n\nدابا البوت مش متصل ظاهرياً${POWERED_BY}` }, msg);

                // Start periodic updates if not already running
                if (!presenceInterval) {
                    const presenceDelay = 50000 + Math.floor(Math.random() * 20000);
                    presenceInterval = setInterval(async () => {
                        try { await sock.sendPresenceUpdate('unavailable'); } catch {}
                    }, presenceDelay);
                }
            } catch (error) {
                await sendBotMessage(sock, remoteJid, { text: `❌ مشكل فتغيير الحالة${POWERED_BY}` }, msg);
            }
            return;
        }

        if (text === '/online') {
            botPresenceMode = 'available';
            try { 
                await sock.sendPresenceUpdate(botPresenceMode); 
                await sendBotMessage(sock, remoteJid, { text: `🟢 *البوت ولى Online*\n\nدابا البوت متصل${POWERED_BY}` }, msg);

                // Clear periodic updates
                if (presenceInterval) {
                    clearInterval(presenceInterval);
                    presenceInterval = null;
                }
            } catch (error) {
                await sendBotMessage(sock, remoteJid, { text: `❌ مشكل فتغيير الحالة${POWERED_BY}` }, msg);
            }
            return;
        }

        if (lowerText === '/antipv on' || lowerText === 'antipv on') {
            antiPrivateSettings.setEnabled(true);
            await sendBotMessage(sock, remoteJid, { 
                text: `✅ *تم تفعيل حظر الرسائل الخاصة*\n\nالبوت الآن يعمل في المجموعات فقط\nسيتم حظر من يرسل في الخاص${POWERED_BY}` 
            }, msg);
            return;
        }

        if (lowerText === '/antipv off' || lowerText === 'antipv off') {
            antiPrivateSettings.setEnabled(false);
            await sendBotMessage(sock, remoteJid, { 
                text: `❌ *تم إيقاف حظر الرسائل الخاصة*\n\nالبوت الآن يعمل في الخاص والمجموعات${POWERED_BY}` 
            }, msg);
            return;
        }

        if (lowerText === '/antipv status' || lowerText === 'antipv status') {
            const status = antiPrivateSettings.isEnabled() ? '✅ مفعل' : '❌ معطل';
            const blockedCount = antiPrivateSettings.data.blockedInPrivate?.length || 0;
            await sendBotMessage(sock, remoteJid, { 
                text: `📊 *حالة Anti-Private:*\n\n${status}\nالمحظورين في الخاص: ${blockedCount}${POWERED_BY}` 
            }, msg);
            return;
        }

        if (lowerText === '/antipv clear' || lowerText === 'antipv clear') {
            antiPrivateSettings.data.blockedInPrivate = [];
            await sendBotMessage(sock, remoteJid, { 
                text: `✅ تم مسح قائمة المحظورين في الخاص${POWERED_BY}` 
            }, msg);
            return;
        }

        if (text === '/admin') {
            const adminHelp = `🔧 *أوامر المطور*

◄ /stats - احصائيات البوت
◄ /broadcast [رسالة] - ارسال لمجموعة
◄ /block [رقم] - بلوك
◄ /unblock [رقم] - رفع البلوك
◄ /offline - البوت يبان offline
◄ /online - البوت يبان online${POWERED_BY}`;
            await sendBotMessage(sock, remoteJid, { text: adminHelp }, msg);
            return;
        }
    }

    // Handle /cancel command to reset search state
    if (lowerText === '/cancel' || lowerText === 'الغاء' || lowerText === 'إلغاء') {
        if (session.lastListMessageKey) {
            try { await sock.sendMessage(remoteJid, { delete: session.lastListMessageKey }); } catch {}
            session.lastListMessageKey = null;
        }
        session.state = 'idle';
        session.searchResults = [];
        userSessions.set(userId, session);

        await sendBotMessage(sock, remoteJid, { 
            text: `تم إلغاء البحث. صيفط اسم التطبيق${POWERED_BY}`
        }, msg);
        return;
    }

    // Handle messages starting with "." - tell user to send app name only
    if (text.startsWith('.')) {
        await sendBotMessage(sock, remoteJid, { 
            text: `صيفط غير اسم التطبيق بلا أوامر
مثال اصاحبي : WhatsApp${POWERED_BY}`
        }, msg);
        return;
    }

    if (lowerText === '/help' || lowerText === 'مساعدة' || lowerText === 'help') {
        const helpText = `*المساعدة*

كيف كانخدم:
1. صيفط اسم التطبيق لي بغيتي
2. اختار رقم من القائمة 
3. تسنى حتى نصيفطلك التطبيق 

الأوامر:
/help /commands /history /ping /info /dev
zarchiver - باش تثبت XAPK

نصائح:
• قلب بالانجليزية
• XAPK خاصو ZArchiver${POWERED_BY}`;

        await sendBotMessage(sock, remoteJid, { text: helpText }, msg);
        return;
    }

    if (lowerText === '/commands' || lowerText === 'الاوامر' || lowerText === 'اوامر') {
        const commandsText = `*الأوامر*

/help • مساعدة
/commands • لائحة الأوامر
/history • السجل
/ping • اختبار البوت
/info • معلومات
/dev • المطور
/cancel • إلغاء البحث
zarchiver • تنزل  زارشيفر

أمثلة:
WhatsApp, Minecraft, Free Fire${POWERED_BY}`;

        await sendBotMessage(sock, remoteJid, { text: commandsText }, msg);
        return;
    }

    if (lowerText === '/ping' || lowerText === 'بينج') {
        const startTime = Date.now();
        await sendBotMessage(sock, remoteJid, { 
            text: `PONG! ${Date.now() - startTime}ms${POWERED_BY}`
        }, msg);
        return;
    }

    if (lowerText === '/info' || lowerText === 'معلومات') {
        const infoText = `*معلومات البوت*
Omar AI Bot v3.0
المصدر: APKPure
كيّساند APK و XAPK${POWERED_BY}`;
        await sendBotMessage(sock, remoteJid, { text: infoText }, msg);
        return;
    }

    if (lowerText === '/dev' || lowerText === 'المطور' || lowerText === 'تواصل') {
        await sendBotMessage(sock, remoteJid, { text: `${INSTAGRAM_URL}${POWERED_BY}` }, msg, { skipDelay: true });
        return;
    }

    if (lowerText === '/history' || lowerText === 'سجلي' || lowerText === 'history') {
        const history = await getUserHistory(senderPhone);
        if (history.length === 0) {
            await sendBotMessage(sock, remoteJid, { 
                text: `📭 *ماعندك حتى سجل*

مازال مجبدتي حتى تطبيق 
صيفط اسم باش نبحثلك${POWERED_BY}`
            }, msg);
        } else {
            let historyText = `📜 *سجل التنزيلات ديالك*\n`;
            history.forEach((item, i) => {
                const date = new Date(item.created_at).toLocaleDateString('ar-EG');
                historyText += `\n${i + 1}◄ ${item.app_name} (${item.file_type.toUpperCase()})`;
            });
            historyText += POWERED_BY;
            await sendBotMessage(sock, remoteJid, { text: historyText }, msg);
        }
        return;
    }

    if (isGroup && (isAdmin || await isUserAdmin(sock, remoteJid, senderJid))) {
        if (lowerText === '/protect' || lowerText === 'حماية' || lowerText === '/حماية') {
            const result = await enableAllProtection(sock, remoteJid);
            await sendBotMessage(sock, remoteJid, { text: result.message + POWERED_BY }, msg);
            return;
        }

        if (lowerText === '/status' || lowerText === 'الحالة' || lowerText === '/الحالة') {
            const status = getGroupProtectionStatus(remoteJid);
            await sendBotMessage(sock, remoteJid, { text: status + POWERED_BY }, msg);
            return;
        }

        if (lowerText === '/antilink on' || lowerText === 'antilink on') {
            const result = await setAntiLink(remoteJid, true);
            await sendBotMessage(sock, remoteJid, { text: result.message + POWERED_BY }, msg);
            return;
        }

        if (lowerText === '/antilink off' || lowerText === 'antilink off') {
            const result = await setAntiLink(remoteJid, false);
            await sendBotMessage(sock, remoteJid, { text: result.message + POWERED_BY }, msg);
            return;
        }

        if (lowerText === '/antiword on' || lowerText === 'antiword on') {
            const result = await setAntiBadWords(remoteJid, true);
            await sendBotMessage(sock, remoteJid, { text: result.message + POWERED_BY }, msg);
            return;
        }

        if (lowerText === '/antiword off' || lowerText === 'antiword off') {
            const result = await setAntiBadWords(remoteJid, false);
            await sendBotMessage(sock, remoteJid, { text: result.message + POWERED_BY }, msg);
            return;
        }

        if (lowerText.startsWith('/antitime on') || lowerText.startsWith('antitime on')) {
            const parts = text.split(' ');
            const closeTime = parts[2] || '20:00';
            const openTime = parts[3] || '08:00';
            const result = await setAntiTime(sock, remoteJid, true, closeTime, openTime);
            await sendBotMessage(sock, remoteJid, { text: result.message + POWERED_BY }, msg);
            return;
        }

        if (lowerText === '/antitime off' || lowerText === 'antitime off') {
            const result = await setAntiTime(sock, remoteJid, false);
            await sendBotMessage(sock, remoteJid, { text: result.message + POWERED_BY }, msg);
            return;
        }

        if (lowerText === '/admin' || lowerText === 'اوامر المسؤول' || lowerText === '/اوامر') {
            const adminCommands = `*🛡️ أوامر حماية المجموعة:*

/protect - تفعيل جميع الحمايات
/status - عرض حالة الحمايات

*Anti-Link (حذف الروابط):*
/antilink on - تفعيل
/antilink off - إيقاف

*Anti-Word (حذف الكلمات الممنوعة):*
/antiword on - تفعيل
/antiword off - إيقاف

*Anti-Time (إغلاق/فتح تلقائي):*
/antitime on 20:00 08:00 - تفعيل
/antitime off - إيقاف

_ملاحظة: هذه الأوامر للمسؤولين فقط_`;
            await sendBotMessage(sock, remoteJid, { text: adminCommands + POWERED_BY }, msg);
            return;
        }
    }

    if (session.state === 'idle' || session.state === 'waiting_for_search') {
        await sock.sendMessage(remoteJid, { react: { text: '🤔', key: msg.key } });
        await sock.sendPresenceUpdate('composing', remoteJid);

        try {
            if (mediaData) {
                console.log(`🖼️ إرسال صورة إلى Gemini: ${mediaData.mimeType}, النص: "${text || '[بدون نص]'}"`);
            }
            const quotedText = extractQuotedText(msg);
            const geminiResponse = quotedText 
                ? await processMessageWithQuote(userId, text, quotedText, mediaData)
                : await processMessage(userId, text, mediaData);
            console.log('🧠 Gemini Response:', JSON.stringify(geminiResponse));

            if (geminiResponse.action === 'search_app') {
                await sock.sendMessage(remoteJid, { react: { text: '🔍', key: msg.key } });
                session.state = 'waiting_for_search';
                userSessions.set(userId, session);

                const searchQuery = geminiResponse.query || text;
                console.log('🔎 كنبحث على:', searchQuery);
                const isPackageName = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/i.test(searchQuery.trim());
                let results;
                try {
                    if (isPackageName) {
                        const appDetails = await getAppFromAPKPure(searchQuery.trim());
                        if (appDetails) {
                            results = [appDetails];
                        } else {
                            results = await searchAPKPure(searchQuery, 10);
                        }
                    } else {
                        results = await searchAPKPure(searchQuery, 10);
                    }
                    console.log('📊 نتائج البحث:', results?.length || 0);
                } catch (searchError) {
                    console.error('❌ خطأ في البحث:', searchError.message);
                    await sendBotMessage(sock, remoteJid, { 
                        text: `وقع مشكل فالبحث. جرب مرة أخرى.${POWERED_BY}`
                    }, msg);
                    session.state = 'idle';
                    userSessions.set(userId, session);
                    return;
                }

                if (!results || results.length === 0) {
                    await sendBotMessage(sock, remoteJid, { 
                        text: `ماعنديش نتائج على "${searchQuery}". جرب تكتب بالانجليزية${POWERED_BY}`
                    }, msg);
                    session.state = 'idle';
                    userSessions.set(userId, session);
                    return;
                }

                const cleanResults = results.map((app, idx) => ({
                    title: app.title,
                    appId: app.appId || app.id || app.packageName || null,
                    developer: app.developer || '',
                    score: app.score || 0,
                    icon: app.icon || null,
                    index: idx + 1,
                    source: app.source || 'APKPure',
                    isMod: app.isMod || false,
                    isGame: app.isGame || false,
                    url: app.url || null
                }));

                session.searchResults = [...cleanResults];
                session.state = 'waiting_for_selection';
                session.lastSearchQuery = searchQuery;
                userSessions.set(userId, session);

                // إرسال النتائج كقائمة تفاعلية (Interactive List)
                try {
                    const sections = [{
                        title: 'نتائج البحث',
                        rows: cleanResults.map((app, idx) => {
                            let description = '';
                            if (app.isMod) {
                                description = `مهكرة - ${app.source || 'AN1'}`;
                            } else if (app.source && app.source !== 'APKPure') {
                                description = `${app.source}${app.developer ? ' | ' + app.developer : ''}`;
                            } else if (app.developer) {
                                description = `المطور: ${app.developer}`;
                            }
                            return {
                                id: String(idx + 1),
                                title: `${idx + 1}. ${app.title}${app.isMod ? ' 🔓' : ''}`,
                                description: description
                            };
                        })
                    }];

                    const sentMsg = await sendListMenu(
                        sock,
                        remoteJid,
                        `نتائج البحث`,
                        `لقيت ${cleanResults.length} تطبيق لـ: *${searchQuery}*`,
                        'Omar AI Bot',
                        'نتائج البحث',
                        sections,
                        msg
                    );
                    session.lastListMessageKey = sentMsg?.key;
                    userSessions.set(userId, session);
                    
                    if (isGroup && sentMsg?.key?.id) {
                        groupListsStore.set(sentMsg.key.id, {
                            ownerId: userId,
                            searchResults: [...cleanResults],
                            searchQuery: searchQuery,
                            timestamp: Date.now()
                        });
                    }
                    console.log('✅ تصيفطت نتائج البحث (Interactive List)');
                } catch (listError) {
                    console.log('⚠️ فشل إرسال القائمة التفاعلية، استخدام النص العادي:', listError.message);
                    const resultText = formatSearchResults(cleanResults, searchQuery) + POWERED_BY;
                    const sentMsg = await sendBotMessage(sock, remoteJid, { text: resultText }, msg, { skipDelay: true });
                    session.lastListMessageKey = sentMsg?.key;
                    userSessions.set(userId, session);
                    console.log('✅ تصيفطت نتائج البحث (نص عادي)');
                }

                // حفظ نتائج البحث في ذاكرة المحادثة مع appId
                const appDetails = cleanResults.map(app => `${app.index}. ${app.title} (appId: ${app.appId})`).join('\n');
                addContext(userId, `📋 قائمة التطبيقات المعروضة للمستخدم:\n${appDetails}\n\n⚠️ مهم: إذا قال المستخدم رقم (1 أو 2 أو 3...)، استخدم download_app مع appId المناسب من القائمة أعلاه.`);

            } else if (geminiResponse.action === 'download_app') {
                await sock.sendMessage(remoteJid, { react: { text: '📥', key: msg.key } });
                const appId = geminiResponse.appId;
                const appName = geminiResponse.appName || appId;

                await sendBotMessage(sock, remoteJid, { text: `كننزّل ليك ${appName}...${POWERED_BY}` }, msg);

                session.state = 'waiting_for_selection';
                session.searchResults = [{ title: appName, appId: appId, index: 1 }];
                userSessions.set(userId, session);
                await handleAppDownload(sock, remoteJid, userId, senderPhone, msg, appId, appName, session, isAdmin);

            } else if (geminiResponse.action === 'download_media') {
                const url = geminiResponse.url;
                const platform = geminiResponse.platform;

                await sendBotMessage(sock, remoteJid, { text: `كننزّل ليك الفيديو من ${platform}...${POWERED_BY}` }, msg);

                const handled = await handlePluginUrl(sock, remoteJid, url, msg, senderPhone);
                if (!handled) {
                    await sendBotMessage(sock, remoteJid, { text: `مقديتش نجيب الفيديو. جرب رابط آخر.${POWERED_BY}` }, msg);
                }

            } else if (geminiResponse.action === 'recommend_app') {
                await sock.sendMessage(remoteJid, { react: { text: '💡', key: msg.key } });

                const message = geminiResponse.message || 'هاك بعض التوصيات:';
                const apps = geminiResponse.apps || [];

                let recommendText = `💡 *${message}*\n`;

                if (apps.length > 0) {
                    apps.forEach((app, idx) => {
                        recommendText += `\n${idx + 1}️⃣ *${app.name}*\n`;
                        if (app.reason) {
                            recommendText += `   └ ${app.reason}\n`;
                        }
                    });

                    recommendText += `\n📥 *صيفط الرقم باش ننزّل ليك التطبيق*`;
                    recommendText += POWERED_BY;

                    const cleanResults = apps.map((app, idx) => ({
                        title: app.name,
                        appId: null,
                        searchQuery: app.query || app.name,
                        developer: '',
                        score: 0,
                        icon: null,
                        index: idx + 1
                    }));

                    session.searchResults = [...cleanResults];
                    session.state = 'waiting_for_recommendation_selection';
                    userSessions.set(userId, session);

                    const sentMsg = await sendBotMessage(sock, remoteJid, { text: recommendText }, msg, { skipDelay: true });
                    session.lastListMessageKey = sentMsg?.key;
                    userSessions.set(userId, session);

                    const appDetails = apps.map((app, idx) => `${app.index}. ${app.name} (للبحث: ${app.query || app.name})`).join('\n');
                    addContext(userId, `📋 توصيات التطبيقات المعروضة:\n${appDetails}\n\n⚠️ مهم: إذا قال المستخدم رقم، ابحث عن التطبيق المقابل باستخدام search_app مع اسم البحث.`);
                } else {
                    recommendText += POWERED_BY;
                    await sendBotMessage(sock, remoteJid, { text: recommendText }, msg);
                }

            } else if (geminiResponse.action === 'reply' || geminiResponse.action === 'analyze_image') {
                const message = geminiResponse.message || 'مفهمتش. عاود صيفط.';
                await sendBotMessage(sock, remoteJid, { text: `${message}${POWERED_BY}` }, msg);

            } else {
                await sendBotMessage(sock, remoteJid, { text: `كيفاش نقدر نعاونك؟${POWERED_BY}` }, msg);
            }

        } catch (error) {
            console.error('❌ مشكل فـ Gemini:', error);
            await sendBotMessage(sock, remoteJid, { text: `عذراً، وقع مشكل. عاود المحاولة.${POWERED_BY}` }, msg, { skipDelay: true });
        }

    } else if (session.state === 'waiting_for_selection') {
        // تحقق من الاستجابة التفاعلية (Interactive Response)
        let selection = parseInt(text.trim());
        const interactiveResponse = parseInteractiveResponse(msg);
        
        if (interactiveResponse && interactiveResponse.id) {
            // استخراج الرقم من ID الزر (رقم مباشر أو app_X)
            const id = interactiveResponse.id;
            if (/^\d+$/.test(id)) {
                selection = parseInt(id);
                console.log(`🔘 اختيار تفاعلي (رقم): ${id} -> ${selection}`);
            } else {
                const match = id.match(/(\d+)/);
                if (match) {
                    selection = parseInt(match[1]);
                    console.log(`🔘 اختيار تفاعلي (app_X): ${id} -> ${selection}`);
                }
            }
        }
        
        const resultsCount = session.searchResults?.length || 0;

        if (isNaN(selection) || selection < 1 || selection > resultsCount) {
            // User entered text instead of a number - increment counter
            session.requestsWithList = (session.requestsWithList || 0) + 1;
            
            // احفظ حالة القائمة قبل أي تعديل
            const shouldKeepList = session.requestsWithList < 10 && session.searchResults && session.searchResults.length > 0;
            
            // إذا تجاوز 10 طلبات، امسح القائمة
            if (session.requestsWithList >= 10) {
                if (session.lastListMessageKey) {
                    try { await sock.sendMessage(remoteJid, { delete: session.lastListMessageKey }); } catch {}
                    session.lastListMessageKey = null;
                }
                session.searchResults = [];
                session.requestsWithList = 0;
                console.log(`📋 تم مسح قائمة التطبيقات بعد 10 طلبات`);
            }
            
            // علم للإرجاع لحالة الانتظار بعد المعالجة
            session._shouldRestoreSelection = shouldKeepList;
            session.state = 'idle';
            userSessions.set(userId, session);

            // Ask Gemini what the user wants
            await sock.sendMessage(remoteJid, { react: { text: '🤔', key: msg.key } });
            await sock.sendPresenceUpdate('composing', remoteJid);

            try {
                const quotedText = extractQuotedText(msg);
                const geminiResponse = quotedText 
                    ? await processMessageWithQuote(userId, text, quotedText, mediaData)
                    : await processMessage(userId, text, mediaData);
                console.log('🧠 Gemini Response (from selection):', JSON.stringify(geminiResponse));

                if (geminiResponse.action === 'search_app') {
                    await sock.sendMessage(remoteJid, { react: { text: '🔍', key: msg.key } });
                    
                    // مسح القائمة القديمة عند بحث جديد
                    if (session.lastListMessageKey) {
                        try { await sock.sendMessage(remoteJid, { delete: session.lastListMessageKey }); } catch {}
                        session.lastListMessageKey = null;
                    }
                    session.searchResults = [];
                    session.requestsWithList = 0;
                    delete session._shouldRestoreSelection;
                    
                    session.state = 'waiting_for_search';
                    userSessions.set(userId, session);

                    const searchQuery = geminiResponse.query || text;
                    console.log('🔎 كنبحث على (selection):', searchQuery);
                    const isPackageName = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/i.test(searchQuery.trim());
                    let results;
                    try {
                        if (isPackageName) {
                            const appDetails = await getAppFromAPKPure(searchQuery.trim());
                            if (appDetails) {
                                results = [appDetails];
                            } else {
                                results = await searchAPKPure(searchQuery, 10);
                            }
                        } else {
                            results = await searchAPKPure(searchQuery, 10);
                        }
                        console.log('📊 نتائج البحث (selection):', results?.length || 0);
                    } catch (searchError) {
                        console.error('❌ خطأ في البحث (selection):', searchError.message);
                        await sendBotMessage(sock, remoteJid, { 
                            text: `وقع مشكل فالبحث. جرب مرة أخرى.${POWERED_BY}`
                        }, msg);
                        session.state = 'idle';
                        userSessions.set(userId, session);
                        return;
                    }

                    if (!results || results.length === 0) {
                        await sendBotMessage(sock, remoteJid, { 
                            text: `ماعنديش نتائج على "${searchQuery}". جرب تكتب بالانجليزية${POWERED_BY}`
                        }, msg);
                        session.state = 'idle';
                        userSessions.set(userId, session);
                        return;
                    }

                    const cleanResults = results.map((app, idx) => ({
                        title: app.title,
                        appId: app.appId || app.id || app.packageName || null,
                        developer: app.developer || '',
                        score: app.score || 0,
                        icon: app.icon || null,
                        index: idx + 1,
                        source: app.source || 'APKPure',
                        isMod: app.isMod || false,
                        url: app.url || null
                    }));

                    session.searchResults = [...cleanResults];
                    session.state = 'waiting_for_selection';
                    session.lastSearchQuery = searchQuery;
                    userSessions.set(userId, session);

                    // إرسال النتائج كقائمة تفاعلية
                    try {
                        const sections = [{
                            title: 'نتائج البحث',
                            rows: cleanResults.map((app, idx) => {
                                let description = '';
                                if (app.isMod) {
                                    description = `مهكرة - ${app.source || 'AN1'}`;
                                } else if (app.source && app.source !== 'APKPure') {
                                    description = `${app.source}${app.developer ? ' | ' + app.developer : ''}`;
                                } else if (app.developer) {
                                    description = `المطور: ${app.developer}`;
                                }
                                return {
                                    id: String(idx + 1),
                                    title: `${idx + 1}. ${app.title}${app.isMod ? ' 🔓' : ''}`,
                                    description: description
                                };
                            })
                        }];

                        const sentMsg = await sendListMenu(
                            sock,
                            remoteJid,
                            `نتائج البحث`,
                            `لقيت ${cleanResults.length} تطبيق لـ: *${searchQuery}*`,
                            'Omar AI Bot',
                            'نتائج البحث',
                            sections,
                            msg
                        );
                        session.lastListMessageKey = sentMsg?.key;
                        userSessions.set(userId, session);
                        console.log('✅ تصيفطت نتائج البحث (Interactive - selection)');
                    } catch (listError) {
                        console.log('⚠️ فشل القائمة التفاعلية (selection):', listError.message);
                        const resultText = formatSearchResults(cleanResults, searchQuery) + POWERED_BY;
                        const sentMsg = await sendBotMessage(sock, remoteJid, { text: resultText }, msg, { skipDelay: true });
                        session.lastListMessageKey = sentMsg?.key;
                        userSessions.set(userId, session);
                        console.log('✅ تصيفطت نتائج البحث (نص - selection)');
                    }

                    // حفظ نتائج البحث في ذاكرة المحادثة
                    const appNames = cleanResults.map(app => `${app.index}. ${app.title}`).join('\n');
                    addContext(userId, `عرضت للمستخدم نتائج البحث عن "${searchQuery}":\n${appNames}\nالمستخدم يمكنه اختيار رقم أو طلب شيء آخر.`);

                } else if (geminiResponse.action === 'download_app') {
                    await sock.sendMessage(remoteJid, { react: { text: '📥', key: msg.key } });
                    const appId = geminiResponse.appId;
                    const appName = geminiResponse.appName || appId;

                    await sendBotMessage(sock, remoteJid, { text: `كننزّل ليك ${appName}...${POWERED_BY}` }, msg);

                    session.state = 'waiting_for_selection';
                    session.searchResults = [{ title: appName, appId: appId, index: 1 }];
                    userSessions.set(userId, session);
                    await handleAppDownload(sock, remoteJid, userId, senderPhone, msg, appId, appName, session, isAdmin);

                } else if (geminiResponse.action === 'download_media') {
                    const url = geminiResponse.url;
                    const platform = geminiResponse.platform;

                    await sendBotMessage(sock, remoteJid, { text: `كننزّل ليك الفيديو من ${platform}...${POWERED_BY}` }, msg);

                    const handled = await handlePluginUrl(sock, remoteJid, url, msg, senderPhone);
                    if (!handled) {
                        await sendBotMessage(sock, remoteJid, { text: `مقديتش نجيب الفيديو. جرب رابط آخر.${POWERED_BY}` }, msg);
                    }

                } else if (geminiResponse.action === 'reply' || geminiResponse.action === 'analyze_image') {
                    const message = geminiResponse.message || 'مفهمتش. عاود صيفط.';
                    await sendBotMessage(sock, remoteJid, { text: `${message}${POWERED_BY}` }, msg);

                } else {
                    await sendBotMessage(sock, remoteJid, { text: `كيفاش نقدر نعاونك؟${POWERED_BY}` }, msg);
                }

            } catch (error) {
                console.error('❌ مشكل فـ Gemini:', error);
                await sendBotMessage(sock, remoteJid, { text: `عذراً، وقع مشكل. عاود المحاولة.${POWERED_BY}` }, msg, { skipDelay: true });
            }
            
            // إرجاع الحالة لـ waiting_for_selection إذا القائمة لا تزال موجودة
            if (session._shouldRestoreSelection) {
                session.state = 'waiting_for_selection';
                delete session._shouldRestoreSelection;
                userSessions.set(userId, session);
            }
            return;
        }

        const selectedApp = session.searchResults[selection - 1];
        await handleAppDownload(sock, remoteJid, userId, senderPhone, msg, selectedApp.appId, selectedApp.title, session, isAdmin, selectedApp);

    } else if (session.state === 'waiting_for_recommendation_selection') {
        const selection = parseInt(text.trim());
        const resultsCount = session.searchResults?.length || 0;

        if (isNaN(selection) || selection < 1 || selection > resultsCount) {
            if (session.lastListMessageKey) {
                try { await sock.sendMessage(remoteJid, { delete: session.lastListMessageKey }); } catch {}
                session.lastListMessageKey = null;
            }

            session.state = 'idle';
            session.searchResults = [];
            userSessions.set(userId, session);

            await sock.sendMessage(remoteJid, { react: { text: '🤔', key: msg.key } });
            await sock.sendPresenceUpdate('composing', remoteJid);

            try {
                const quotedText = extractQuotedText(msg);
                const geminiResponse = quotedText 
                    ? await processMessageWithQuote(userId, text, quotedText, mediaData)
                    : await processMessage(userId, text, mediaData);
                console.log('🧠 Gemini Response (from recommendation):', JSON.stringify(geminiResponse));

                if (geminiResponse.action === 'search_app') {
                    await sock.sendMessage(remoteJid, { react: { text: '🔍', key: msg.key } });
                    session.state = 'waiting_for_search';
                    userSessions.set(userId, session);

                    const searchQuery = geminiResponse.query || text;
                    const results = await searchAPKPure(searchQuery, 10);

                    if (!results || results.length === 0) {
                        await sendBotMessage(sock, remoteJid, { 
                            text: `ماعنديش نتائج على "${searchQuery}". جرب تكتب بالانجليزية${POWERED_BY}`
                        }, msg);
                        session.state = 'idle';
                        userSessions.set(userId, session);
                        return;
                    }

                    const cleanResults = results.map((app, idx) => ({
                        title: app.title,
                        appId: app.appId || app.id || app.packageName || null,
                        developer: app.developer || '',
                        score: app.score || 0,
                        icon: app.icon || null,
                        index: idx + 1,
                        source: app.source || 'APKPure',
                        isMod: app.isMod || false,
                        url: app.url || null
                    }));

                    session.searchResults = [...cleanResults];
                    session.state = 'waiting_for_selection';

                    const resultText = formatSearchResults(cleanResults, searchQuery) + POWERED_BY;
                    const sentMsg = await sendBotMessage(sock, remoteJid, { text: resultText }, msg, { skipDelay: true });
                    session.lastListMessageKey = sentMsg?.key;
                    session.lastSearchQuery = searchQuery;
                    userSessions.set(userId, session);

                } else if (geminiResponse.action === 'recommend_app') {
                    await sock.sendMessage(remoteJid, { react: { text: '💡', key: msg.key } });

                    const message = geminiResponse.message || 'هاك بعض التوصيات:';
                    const apps = geminiResponse.apps || [];

                    let recommendText = `💡 *${message}*\n`;

                    if (apps.length > 0) {
                        apps.forEach((app, idx) => {
                            recommendText += `\n${idx + 1}️⃣ *${app.name}*\n`;
                            if (app.reason) {
                                recommendText += `   └ ${app.reason}\n`;
                            }
                        });

                        recommendText += `\n📥 *صيفط الرقم باش ننزّل ليك التطبيق*`;
                        recommendText += POWERED_BY;

                        const cleanResults = apps.map((app, idx) => ({
                            title: app.name,
                            appId: null,
                            searchQuery: app.query || app.name,
                            developer: '',
                            score: 0,
                            icon: null,
                            index: idx + 1
                        }));

                        session.searchResults = [...cleanResults];
                        session.state = 'waiting_for_recommendation_selection';
                        userSessions.set(userId, session);

                        const sentMsg = await sendBotMessage(sock, remoteJid, { text: recommendText }, msg, { skipDelay: true });
                        session.lastListMessageKey = sentMsg?.key;
                        userSessions.set(userId, session);
                    } else {
                        recommendText += POWERED_BY;
                        await sendBotMessage(sock, remoteJid, { text: recommendText }, msg);
                    }

                } else if (geminiResponse.action === 'reply' || geminiResponse.action === 'analyze_image') {
                    const message = geminiResponse.message || 'مفهمتش. عاود صيفط.';
                    await sendBotMessage(sock, remoteJid, { text: `${message}${POWERED_BY}` }, msg);

                } else {
                    await sendBotMessage(sock, remoteJid, { text: `كيفاش نقدر نعاونك؟${POWERED_BY}` }, msg);
                }

            } catch (error) {
                console.error('❌ مشكل فـ Gemini:', error);
                await sendBotMessage(sock, remoteJid, { text: `عذراً، وقع مشكل. عاود المحاولة.${POWERED_BY}` }, msg, { skipDelay: true });
            }
            return;
        }

        const selectedApp = session.searchResults[selection - 1];
        const searchQuery = selectedApp.searchQuery || selectedApp.title;

        await sock.sendMessage(remoteJid, { react: { text: '🔍', key: msg.key } });
        await sendBotMessage(sock, remoteJid, { text: `كنبحث على ${selectedApp.title}...${POWERED_BY}` }, msg);

        try {
            const results = await searchAPKPure(searchQuery, 5);

            if (results && results.length > 0) {
                const appId = results[0].appId;
                const appTitle = results[0].title;

                session.state = 'waiting_for_selection';
                session.searchResults = [{ title: appTitle, appId: appId, index: 1 }];
                userSessions.set(userId, session);

                await handleAppDownload(sock, remoteJid, userId, senderPhone, msg, appId, appTitle, session, isAdmin);
            } else {
                await sendBotMessage(sock, remoteJid, { 
                    text: `ماعنديش نتائج على "${searchQuery}". جرب تكتب اسم التطبيق بالانجليزية${POWERED_BY}`
                }, msg);
                session.state = 'idle';
                session.searchResults = [];
                userSessions.set(userId, session);
            }
        } catch (error) {
            console.error('❌ خطأ في البحث عن التوصية:', error.message);
            await sendBotMessage(sock, remoteJid, { 
                text: `وقع مشكل فالبحث. جرب مرة أخرى.${POWERED_BY}`
            }, msg);
            session.state = 'idle';
            session.searchResults = [];
            userSessions.set(userId, session);
        }
    }
}

async function handleAppDownload(sock, remoteJid, userId, senderPhone, msg, appId, appTitle, session, isAdmin = false, selectedApp = null) {
    const numberEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
    const isGroup = remoteJid.endsWith('@g.us');

    // Check hourly download limit
    const downloadLimit = checkHourlyDownloadLimit(senderPhone);
    if (!downloadLimit.allowed) {
        await sock.sendMessage(remoteJid, { react: { text: '⏰', key: msg.key } });
        await sendBotMessage(sock, remoteJid, { 
            text: `⏰ *وصلت الحد الأقصى للتحميلات!*

◄ الحد: *${HOURLY_DOWNLOAD_LIMIT} تحميلات/ساعة*
◄ يرجع بعد: *${downloadLimit.resetIn} دقيقة*

⭐ *للحصول على تحميلات غير محدودة:*
◄ تابع المطور على انستجرام للحصول على VIP مجاناً! 📸
◄ https://www.instagram.com/omarxarafp${POWERED_BY}` 
        }, msg);
        return;
    }

    // Check if this is a mod/external source download (MOD, GamesAPK, AN1, etc.)
    const hasExternalUrl = selectedApp?.url && !selectedApp?.appId?.includes('.');
    const isModDownload = (selectedApp?.isMod || selectedApp?.source === 'GamesAPK' || selectedApp?.isGame) && hasExternalUrl;
    const modSource = selectedApp?.source || 'AN1';

    const selection = session.searchResults.findIndex(app => 
        isModDownload ? app.url === selectedApp.url : app.appId === appId
    ) + 1;
    const emoji = numberEmojis[selection - 1] || '📱';
    await sock.sendMessage(remoteJid, { react: { text: emoji, key: msg.key } });

    if (!isGroup && session.lastListMessageKey) {
        try { await sock.sendMessage(remoteJid, { delete: session.lastListMessageKey }); } catch {}
        session.lastListMessageKey = null;
    }

    session.isDownloading = true;
    startDownloadTracking(senderPhone);
    userSessions.set(userId, session);

    console.log(`✅ تختار: ${appTitle} (${isModDownload ? 'MOD [' + modSource + ']: ' + selectedApp.url : appId})`);

    if (!appId && !isModDownload) {
        await sendBotMessage(sock, remoteJid, { text: `❌ مشكل فالتطبيق. ختار واحد آخر.${POWERED_BY}` }, msg);
        session.isDownloading = false;
        stopDownloadTracking(senderPhone);
        userSessions.set(userId, session);
        return;
    }

    // Handle mod download (AN1, GetModsAPK, GamesAPK, TraidSoft)
    if (isModDownload) {
        let downloadUrl = null;
        
        // Select correct endpoint based on source
        let downloadEndpoint;
        if (modSource === 'GetModsAPK') {
            downloadEndpoint = '/apkmb-download';
        } else if (modSource === 'GamesAPK') {
            downloadEndpoint = '/gamessapk-download';
        } else if (modSource === 'TraidSoft') {
            downloadEndpoint = '/traidsoft-download';
        } else {
            downloadEndpoint = '/an1-download';
        }
        
        await sock.sendMessage(remoteJid, { react: { text: '🔓', key: msg.key } });

        try {
            console.log(`📥 [MOD] Using endpoint: ${downloadEndpoint} for ${selectedApp.url} (source: ${modSource})`);
            const response = await axios.get(`${API_SERVER_URL}${downloadEndpoint}`, {
                params: { url: selectedApp.url },
                timeout: 60000
            });

            if (response.data?.download_url) {
                downloadUrl = response.data.download_url;
                console.log(`📥 [MOD] رابط التحميل: ${downloadUrl.substring(0, 80)}...`);
                
                // If URL is MediaFire, get the direct download link
                if (downloadUrl.includes('mediafire.com')) {
                    console.log(`📥 [MOD] MediaFire detected, getting direct link...`);
                    try {
                        const mfResponse = await axios.get(`${API_SERVER_URL}/mediafire-download`, {
                            params: { url: downloadUrl },
                            timeout: 30000
                        });
                        if (mfResponse.data?.download_url) {
                            downloadUrl = mfResponse.data.download_url;
                            console.log(`📥 [MOD] MediaFire direct link: ${downloadUrl.substring(0, 80)}...`);
                        } else {
                            console.log(`⚠️ [MOD] MediaFire: no direct link found, sending as link`);
                            // Send MediaFire links to user instead of downloading
                            const allLinks = response.data.all_links || [];
                            let linksText = `🎮 *${appTitle}*\n\n`;
                            linksText += `📥 *روابط التحميل من MediaFire:*\n\n`;
                            
                            for (const link of allLinks) {
                                if (link.type === 'mediafire') {
                                    linksText += `📁 ${link.name}\n${link.url}\n\n`;
                                }
                            }
                            linksText += `💡 اضغط على الرابط لتحميل الملف${POWERED_BY}`;
                            
                            await sendBotMessage(sock, remoteJid, { text: linksText }, msg);
                            session.isDownloading = false;
                            stopDownloadTracking(senderPhone);
                            session.state = 'idle';
                            userSessions.set(userId, session);
                            return;
                        }
                    } catch (mfErr) {
                        console.log(`⚠️ [MOD] MediaFire error: ${mfErr.message}`);
                        // Send links to user instead
                        const allLinks = response.data.all_links || [];
                        let linksText = `🎮 *${appTitle}*\n\n`;
                        linksText += `📥 *روابط التحميل:*\n\n`;
                        
                        for (const link of allLinks) {
                            linksText += `📁 ${link.name || link.type}\n${link.url}\n\n`;
                        }
                        linksText += `💡 اضغط على الرابط لتحميل الملف${POWERED_BY}`;
                        
                        await sendBotMessage(sock, remoteJid, { text: linksText }, msg);
                        session.isDownloading = false;
                        stopDownloadTracking(senderPhone);
                        session.state = 'idle';
                        userSessions.set(userId, session);
                        return;
                    }
                }
                
                // If URL is a TraidSoft page (not direct link), send page link instead
                if (modSource === 'TraidSoft' && downloadUrl.includes('app.traidsoft.net') && !downloadUrl.includes('.apk')) {
                    console.log(`📥 [TraidSoft] Sending page link to user...`);
                    let pageText = `🎮 *${appTitle}* (مهكرة)\n\n`;
                    pageText += `📱 *مصدر التحميل:* TraidSoft\n\n`;
                    pageText += `🔗 *رابط الصفحة:*\n${downloadUrl}\n\n`;
                    pageText += `💡 اضغط على الرابط لتحميل التطبيق من TraidSoft${POWERED_BY}`;
                    
                    await sendBotMessage(sock, remoteJid, { text: pageText }, msg);
                    session.isDownloading = false;
                    stopDownloadTracking(senderPhone);
                    session.state = 'idle';
                    userSessions.set(userId, session);
                    return;
                }
                
                // Check file size first with HEAD request
                let estimatedSize = 0;
                try {
                    const headResponse = await axios.head(downloadUrl, {
                        timeout: 15000,
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36'
                        }
                    });
                    estimatedSize = parseInt(headResponse.headers['content-length'] || '0', 10);
                    console.log(`📊 [MOD] حجم الملف المتوقع: ${formatFileSize(estimatedSize)}`);
                } catch (headErr) {
                    console.log(`⚠️ [MOD] فشل فحص الحجم: ${headErr.message}`);
                }
                
                // Check size limit for regular users (1GB limit)
                if (estimatedSize > MAX_REGULAR_USER_SIZE && !canDownloadLargeFile(senderPhone, isAdmin)) {
                    await sock.sendMessage(remoteJid, { react: { text: '🚫', key: msg.key } });
                    await sendBotMessage(sock, remoteJid, { 
                        text: `🚫 *التطبيق المهكر كبير بزاف!*

◄ حجم التطبيق: *${formatFileSize(estimatedSize)}*
◄ الحد المسموح: *1 جيغا*

⭐ *باش تحمّل تطبيقات أكبر من 1GB:*
◄ تابع المطور على انستجرام للحصول على VIP مجاناً! 📸
◄ https://www.instagram.com/omarxarafp

💡 جرب تطبيق آخر أصغر${POWERED_BY}` 
                    }, msg);
                    
                    session.isDownloading = false;
                    stopDownloadTracking(senderPhone);
                    session.state = 'waiting_for_search';
                    userSessions.set(userId, session);
                    return;
                }
                
                // Download using aria2c - large files (>1.9GB) auto-split into 1GB parts
                await sock.sendMessage(remoteJid, { react: { text: '⏬', key: msg.key } });
                
                const sanitizedName = appTitle.replace(/[^\w\s\u0600-\u06FF-]/g, '').trim();
                const fileName = `${sanitizedName}_mod.apk`;
                
                const startTime = Date.now();
                const downloadResult = await splitFileFromUrl(downloadUrl, fileName);
                const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(1);
                
                console.log(`✅ [MOD] تم تحميل في ${elapsedTime}s`);
                
                if (downloadResult.needsSplit) {
                    // File was split into parts
                    const { parts, totalSize, originalName } = downloadResult;
                    console.log(`📦 [MOD] تم تقسيم الملف إلى ${parts.length} أجزاء`);
                    
                    await sendBotMessage(sock, remoteJid, { 
                        text: `📦 الملف كبير (${formatFileSize(totalSize)})\nجاري إرسال ${parts.length} أجزاء...${POWERED_BY}` 
                    }, msg);
                    
                    try {
                        for (const part of parts) {
                            const partBuffer = fs.readFileSync(part.path);
                            const partFileName = part.fileName || `${sanitizedName}.7z.${String(part.partNumber).padStart(3, '0')}`;
                            
                            let caption = `🔓 *${appTitle} (مهكرة)*\n\n`;
                            caption += `◄ الجزء: *${part.partNumber}/${part.totalParts}*\n`;
                            caption += `◄ حجم الجزء: *${formatFileSize(part.size)}*\n`;
                            caption += `◄ الحجم الكلي: *${formatFileSize(totalSize)}*\n`;
                            if (part.partNumber === 1) {
                                caption += `\n${getJoinInstructions(sanitizedName, parts.length)}`;
                            }
                            caption += POWERED_BY;
                            
                            await sock.sendMessage(remoteJid, { react: { text: `${part.partNumber}️⃣`, key: msg.key } });
                            
                            await sendBotMessage(sock, remoteJid, {
                                document: partBuffer,
                                mimetype: 'application/x-7z-compressed',
                                fileName: partFileName,
                                caption: caption
                            }, msg, { forward: true });
                            
                            console.log(`✅ [MOD] تم إرسال الجزء ${part.partNumber}/${part.totalParts}: ${formatFileSize(part.size)}`);
                        }
                        
                        await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });
                        console.log(`✅ [MOD] تم إرسال جميع الأجزاء بنجاح`);
                    } finally {
                        cleanupParts(parts);
                    }
                    
                } else {
                    // Single file (no split needed)
                    const { filePath, fileSize } = downloadResult;
                    
                    if (fileSize < 100000) {
                        try { fs.unlinkSync(filePath); } catch (e) {}
                        throw new Error('الملف صغير جداً - قد يكون فاسداً');
                    }
                    
                    const buffer = fs.readFileSync(filePath);
                    const singleFileName = `${sanitizedName} (مهكرة).apk`;
                    
                    let caption = `🔓 *${appTitle} (مهكرة)*\n\n`;
                    caption += `◄ الحجم: *${formatFileSize(fileSize)}*\n`;
                    caption += `◄ المصدر: ${modSource}\n`;
                    caption += `◄ اسم الملف: ${singleFileName}\n`;
                    caption += `\n⚠️ *تحذير:* التطبيقات المهكرة قد تحتوي على مخاطر أمنية`;
                    caption += POWERED_BY;
                    
                    await sock.sendMessage(remoteJid, { react: { text: '📤', key: msg.key } });
                    
                    await sendBotMessage(sock, remoteJid, {
                        document: buffer,
                        mimetype: 'application/vnd.android.package-archive',
                        fileName: singleFileName,
                        caption: caption
                    }, msg, { forward: true });
                    
                    await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });
                    console.log(`✅ [MOD] تم إرسال الملف بنجاح: ${singleFileName}`);
                    
                    try { fs.unlinkSync(filePath); } catch (e) {}
                }
            } else {
                await sock.sendMessage(remoteJid, { react: { text: '❌', key: msg.key } });
                await sendBotMessage(sock, remoteJid, { 
                    text: `❌ ماقديتش نجيب رابط التحميل.\n\n🔗 جرب الرابط مباشرة:\n${selectedApp.url}${POWERED_BY}` 
                }, msg);
            }
        } catch (modError) {
            console.error('❌ خطأ في تحميل MOD:', modError.message);
            await sock.sendMessage(remoteJid, { react: { text: '⚠️', key: msg.key } });
            const fallbackMsg = downloadUrl 
                ? `⚠️ *مشكل في التحميل*\n\n📥 رابط التحميل المباشر:\n${downloadUrl}\n\n💡 افتح الرابط في المتصفح${POWERED_BY}`
                : `⚠️ *مشكل في جلب الرابط*\n\n🔗 ادخل للصفحة مباشرة:\n${selectedApp.url}${POWERED_BY}`;
            await sendBotMessage(sock, remoteJid, { text: fallbackMsg }, msg);
        }

        session.isDownloading = false;
        stopDownloadTracking(senderPhone);
        session.state = 'idle';
        session.searchResults = [];
        userSessions.set(userId, session);
        return;
    }

    await sock.sendMessage(remoteJid, { react: { text: '⏳', key: msg.key } });

    // Check file size before downloading (1GB limit for regular users)
    const fileSize = await getFileSizeBeforeDownload(appId);
    if (fileSize > 0) {
        console.log(`📊 حجم الملف المتوقع: ${formatFileSize(fileSize)}`);
        
        if (fileSize > MAX_REGULAR_USER_SIZE && !canDownloadLargeFile(senderPhone, isAdmin)) {
            await sock.sendMessage(remoteJid, { react: { text: '🚫', key: msg.key } });
            
            // Check for lite alternative
            const liteAlt = getLiteAlternative(appTitle);
            let liteMsg = '';
            if (liteAlt) {
                liteMsg = `\n\n💡 *جرب النسخة الخفيفة:*\n◄ صيفط: *${liteAlt.displayName}*`;
            }
            
            await sendBotMessage(sock, remoteJid, { 
                text: `🚫 *التطبيق كبير بزاف!*

◄ حجم التطبيق: *${formatFileSize(fileSize)}*
◄ الحد المسموح: *1 جيغا*

⭐ *باش تحمّل تطبيقات أكبر من 1GB:*
◄ تابع المطور على انستجرام للحصول على VIP مجاناً! 📸
◄ https://www.instagram.com/omarxarafp${liteMsg}

💡 جرب تطبيق آخر أصغر${POWERED_BY}` 
            }, msg);
            
            session.isDownloading = false;
            stopDownloadTracking(senderPhone);
            session.state = 'waiting_for_search';
            userSessions.set(userId, session);
            return;
        }
    }

    try {
        const appDetails = await getAppFromAPKPure(appId) || { title: appTitle, appId: appId };

        if (appDetails.icon) {
            try {
                const { statusCode, body } = await request(appDetails.icon, {
                    method: 'GET',
                    headersTimeout: 10000,
                    bodyTimeout: 10000
                });
                if (statusCode === 200) {
                    const iconData = Buffer.from(await body.arrayBuffer());
                    const stickerBuffer = await sharp(iconData)
                        .resize(512, 512, {
                            fit: 'contain',
                            background: { r: 255, g: 255, b: 255, alpha: 0 }
                        })
                        .webp()
                        .toBuffer();
                    await sendBotMessage(sock, remoteJid, {
                        sticker: stickerBuffer
                    }, msg);
                }
            } catch (iconError) {
                console.log('⚠️ فشل نرسل الأيقونة كاستيكرز:', iconError.message);
            }
        }

        await sock.sendMessage(remoteJid, { react: { text: '📥', key: msg.key } });

        // Send progress message for large downloads (>100MB)
        const isLargeDownload = fileSize > 100 * 1024 * 1024;
        if (isLargeDownload) {
            const estimatedMB = (fileSize / 1024 / 1024).toFixed(0);
            const estimatedTime = Math.ceil(fileSize / (15 * 1024 * 1024)); // ~15 MB/s
            await sendBotMessage(sock, remoteJid, { 
                text: `⏬ *جاري تحميل ملف كبير...*

◄ الحجم: ~${estimatedMB} MB
◄ الوقت المتوقع: ~${estimatedTime > 60 ? Math.ceil(estimatedTime / 60) + ' دقيقة' : estimatedTime + ' ثانية'}

🔄 سيصلك الملف تلقائياً عند الانتهاء${POWERED_BY}` 
            }, msg, { skipDelay: true });
        }

        const apkStream = await downloadAPKWithAxios(appDetails.appId, appDetails.title);

        if (apkStream) {
            // Check size limit AFTER download (catches cases where initial check failed)
            if (apkStream.size > MAX_REGULAR_USER_SIZE && !canDownloadLargeFile(senderPhone, isAdmin)) {
                console.log(`🚫 الملف كبير (${formatFileSize(apkStream.size)}) - مستخدم عادي محظور`);
                
                // Clean up downloaded file
                if (apkStream.filePath && fs.existsSync(apkStream.filePath)) {
                    try { fs.unlinkSync(apkStream.filePath); } catch (e) {}
                }
                
                await sock.sendMessage(remoteJid, { react: { text: '🚫', key: msg.key } });
                
                // Check for lite alternative
                const liteAlt = getLiteAlternative(appDetails.title);
                let liteMsg = '';
                if (liteAlt) {
                    liteMsg = `\n\n💡 *جرب النسخة الخفيفة:*\n◄ صيفط: *${liteAlt.displayName}*`;
                }
                
                await sendBotMessage(sock, remoteJid, { 
                    text: `🚫 *التطبيق كبير بزاف!*

◄ حجم التطبيق: *${formatFileSize(apkStream.size)}*
◄ الحد المسموح: *1 جيغا*

⭐ *باش تحمّل تطبيقات أكبر من 1GB:*
◄ تابع المطور على انستجرام للحصول على VIP مجاناً! 📸
◄ https://www.instagram.com/omarxarafp${liteMsg}

💡 جرب تطبيق آخر أصغر${POWERED_BY}` 
                }, msg);
                
                session.isDownloading = false;
                stopDownloadTracking(senderPhone);
                session.state = 'waiting_for_search';
                userSessions.set(userId, session);
                return;
            }
            
            if (needsSplitting(apkStream.size)) {
                await sock.sendMessage(remoteJid, { react: { text: '✂️', key: msg.key } });
                await sendBotMessage(sock, remoteJid, { 
                    text: `📦 *الملف كبير - سيتم تقسيمه*

◄ حجم التطبيق: ${formatFileSize(apkStream.size)}
◄ الحد المسموح لـ WhatsApp: 1.9 جيغا

⏳ جاري تقسيم الملف إلى أجزاء...${POWERED_BY}`
                }, msg);

                let tempFilePath = null;
                let shouldDeleteTemp = false;
                let parts = [];
                try {
                    const safeTitle = appDetails.title.replace(/[^\w\s\u0600-\u06FF-]/g, '').trim() || appDetails.appId;
                    const fileExt = apkStream.fileType || 'apk';
                    
                    if (apkStream.isFile && apkStream.filePath) {
                        tempFilePath = apkStream.filePath;
                        shouldDeleteTemp = true;
                        console.log(`📁 استخدام الملف المحمل مباشرة: ${tempFilePath}`);
                    } else if (apkStream.buffer) {
                        tempFilePath = path.join(TEMP_DIR, `${Date.now()}_${safeTitle}.${fileExt}`);
                        shouldDeleteTemp = true;
                        if (!fs.existsSync(TEMP_DIR)) {
                            fs.mkdirSync(TEMP_DIR, { recursive: true });
                        }
                        console.log(`📝 كتابة الـ buffer للقرص...`);
                        await fs.promises.writeFile(tempFilePath, apkStream.buffer);
                    } else {
                        throw new Error('لا يوجد ملف أو buffer للتقسيم');
                    }
                    
                    console.log(`✂️ جاري تقسيم الملف...`);
                    parts = await splitFile(tempFilePath);
                    console.log(`✅ تم التقسيم إلى ${parts.length} أجزاء`);
                    
                    await sock.sendMessage(remoteJid, { react: { text: '📤', key: msg.key } });
                    
                    for (const part of parts) {
                        console.log(`📤 إرسال الجزء ${part.partNumber}/${part.totalParts}...`);
                        const partBuffer = await fs.promises.readFile(part.path);
                        const partFileName = part.fileName || `${safeTitle}.7z.${String(part.partNumber).padStart(3, '0')}`;
                        
                        await sendBotMessage(sock, remoteJid, {
                            document: partBuffer,
                            mimetype: 'application/x-7z-compressed',
                            fileName: partFileName,
                            caption: `📦 الجزء ${part.partNumber} من ${part.totalParts}\n◄ الحجم: ${formatFileSize(part.size)}${POWERED_BY}`
                        }, msg, { forward: true });
                        
                        await new Promise(r => setTimeout(r, 3000));
                    }
                    
                    const instructions = getJoinInstructions(`${safeTitle}.${fileExt}`, parts.length);
                    await sendBotMessage(sock, remoteJid, { text: instructions + POWERED_BY }, msg);
                    
                    await logDownload(senderPhone, appDetails.appId, appDetails.title, apkStream.fileType, apkStream.size);
                    recordDownload(senderPhone);
                    await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });
                    console.log(`✅ تم إرسال جميع الأجزاء بنجاح!`);
                    
                } catch (splitError) {
                    console.error('❌ خطأ في تقسيم الملف:', splitError);
                    await sock.sendMessage(remoteJid, { react: { text: '❌', key: msg.key } });
                    await sendBotMessage(sock, remoteJid, { 
                        text: `❌ فشل تقسيم الملف: ${splitError.message}${POWERED_BY}` 
                    }, msg);
                } finally {
                    if (shouldDeleteTemp && tempFilePath && fs.existsSync(tempFilePath)) {
                        try { fs.unlinkSync(tempFilePath); } catch (e) {}
                    }
                    if (parts.length > 0) {
                        cleanupParts(parts);
                    }
                }
                
                session.state = 'waiting_for_search';
                session.isDownloading = false;
                session.searchResults = [];
                stopDownloadTracking(senderPhone);
                userSessions.set(userId, session);
                return;
            }

            await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });

            const isXapk = apkStream.fileType === 'xapk';
            await logDownload(senderPhone, appDetails.appId, appDetails.title, apkStream.fileType, apkStream.size);
            recordDownload(senderPhone);

            if (isXapk) {
                let sanitizedName = appDetails.title
                    .replace(/[<>:"/\\|?*]/g, '')
                    .replace(/\s+/g, '_')
                    .substring(0, 50);

                if (!sanitizedName || sanitizedName.trim() === '') {
                    sanitizedName = appDetails.appId || 'app';
                }

                const xapkAnalysis = analyzeXapkContents(apkStream.buffer);

                if (xapkAnalysis.hasApkPlusObb && xapkAnalysis.apkFile && xapkAnalysis.obbFiles.length > 0) {
                    console.log(`📦 XAPK يحتوي على APK + OBB - سيتم إنشاء ZIP منظم`);

                    const zipResult = buildApkObbZip(appDetails, xapkAnalysis.apkFile, xapkAnalysis.obbFiles);

                    if (zipResult) {
                        let caption = formatAppInfo(appDetails, 'zip', zipResult.size);
                        caption += `\n◄ اسم الملف: ${zipResult.fileName}`;
                        caption += `\n\n${getZipObbTutorial(zipResult.fileName, appDetails.appId, appDetails.title)}`;
                        caption += POWERED_BY;

                        await sendBotMessage(sock, remoteJid, {
                            document: zipResult.buffer,
                            mimetype: 'application/zip',
                            fileName: zipResult.fileName,
                            caption: caption
                        }, msg, { forward: true });
                    } else {
                        const xapkFileName = `${sanitizedName}.xapk`;
                        let caption = formatAppInfo(appDetails, 'xapk', apkStream.size);
                        caption += `\n◄ اسم الملف: ${xapkFileName}`;
                        caption += POWERED_BY;

                        await sendBotMessage(sock, remoteJid, {
                            document: apkStream.buffer,
                            mimetype: 'application/octet-stream',
                            fileName: xapkFileName,
                            caption: caption
                        }, msg, { forward: true });
                    }
                } else {
                    console.log(`📦 XAPK بدون OBB - إرسال كـ XAPK مضغوط`);
                    const xapkFileName = `${sanitizedName}.xapk`;

                    let caption = formatAppInfo(appDetails, 'xapk', apkStream.size);
                    caption += `\n◄ اسم الملف: ${xapkFileName}`;
                    caption += `\n\n${getXapkInstallTutorial(appDetails.title)}`;
                    caption += POWERED_BY;

                    await sendBotMessage(sock, remoteJid, {
                        document: apkStream.buffer,
                        mimetype: 'application/octet-stream',
                        fileName: xapkFileName,
                        caption: caption
                    }, msg, { forward: true });
                }

            } else {
                let caption = formatAppInfo(appDetails, apkStream.fileType, apkStream.size);
                caption += `\n◄ اسم الملف: ${apkStream.filename}`;
                caption += POWERED_BY;

                await sendBotMessage(sock, remoteJid, {
                    document: apkStream.buffer,
                    mimetype: 'application/vnd.android.package-archive',
                    fileName: apkStream.filename,
                    caption: caption
                }, msg, { forward: true });
            }

            await sendBotMessage(sock, remoteJid, { 
                text: `${INSTAGRAM_URL}${POWERED_BY}` 
            }, msg, { forward: true, skipDelay: true });

            // إضافة سياق للمحادثة بأن التطبيق تم إرساله
            addContext(userId, `✅ تم إرسال تطبيق "${appDetails.title}" (${apkStream.fileType.toUpperCase()}, ${formatFileSize(apkStream.size)}) للمستخدم بنجاح. التطبيق وصل للمستخدم.`);

        } else {
            // Primary source failed - try alternative source (AN1)
            console.log(`[Retry] APKPure failed, trying AN1 for: ${appTitle}`);
            await sock.sendMessage(remoteJid, { react: { text: '🔄', key: msg.key } });
            await sendBotMessage(sock, remoteJid, { 
                text: `⏳ المصدر الأول فشل، جاري المحاولة من مصدر بديل...${POWERED_BY}` 
            }, msg);
            
            try {
                const altResults = await searchAlternativeSource(appTitle, 'APKPure');
                if (altResults && altResults.length > 0) {
                    const altApp = altResults[0];
                    console.log(`[Retry] Found alternative: ${altApp.title} from AN1`);
                    
                    if (altApp.url) {
                        const response = await axios.get(`${API_SERVER_URL}/an1-download`, {
                            params: { url: altApp.url },
                            timeout: 60000
                        });
                        
                        if (response.data?.download_url) {
                            const downloadUrl = response.data.download_url;
                            const sanitizedName = appTitle.replace(/[^\w\s\u0600-\u06FF-]/g, '').trim();
                            const fileName = `${sanitizedName}.apk`;
                            
                            // Check file size before downloading from alternative source
                            let altFileSize = 0;
                            try {
                                const headResponse = await axios.head(downloadUrl, {
                                    timeout: 15000,
                                    headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36' }
                                });
                                altFileSize = parseInt(headResponse.headers['content-length'] || '0', 10);
                                console.log(`📊 [Alt] حجم الملف المتوقع: ${formatFileSize(altFileSize)}`);
                            } catch (e) {
                                console.log(`⚠️ [Alt] فشل فحص الحجم: ${e.message}`);
                            }
                            
                            // Check size limit for regular users (1GB limit)
                            if (altFileSize > MAX_REGULAR_USER_SIZE && !canDownloadLargeFile(senderPhone, isAdmin)) {
                                await sock.sendMessage(remoteJid, { react: { text: '🚫', key: msg.key } });
                                await sendBotMessage(sock, remoteJid, { 
                                    text: `🚫 *التطبيق كبير بزاف!*\n\n◄ حجم التطبيق: *${formatFileSize(altFileSize)}*\n◄ الحد المسموح: *1 جيغا*\n\n⭐ للحصول على VIP: تابع @omarxarafp على انستجرام${POWERED_BY}` 
                                }, msg);
                                return;
                            }
                            
                            await sendBotMessage(sock, remoteJid, { 
                                text: `⏬ جاري التحميل من المصدر البديل...${POWERED_BY}` 
                            }, msg);
                            
                            const downloadResult = await splitFileFromUrl(downloadUrl, fileName);
                            
                            if (!downloadResult.needsSplit) {
                                const { filePath, fileSize } = downloadResult;
                                
                                // Double-check size after download
                                if (fileSize > MAX_REGULAR_USER_SIZE && !canDownloadLargeFile(senderPhone, isAdmin)) {
                                    try { fs.unlinkSync(filePath); } catch (e) {}
                                    await sock.sendMessage(remoteJid, { react: { text: '🚫', key: msg.key } });
                                    await sendBotMessage(sock, remoteJid, { 
                                        text: `🚫 *التطبيق كبير بزاف!*\n\n◄ الحد المسموح: *1 جيغا*${POWERED_BY}` 
                                    }, msg);
                                    return;
                                }
                                
                                if (fileSize > 100000) {
                                    const buffer = fs.readFileSync(filePath);
                                    await sendBotMessage(sock, remoteJid, {
                                        document: buffer,
                                        mimetype: 'application/vnd.android.package-archive',
                                        fileName: fileName,
                                        caption: `📱 *${appTitle}*\n◄ الحجم: ${formatFileSize(fileSize)}\n◄ المصدر: AN1${POWERED_BY}`
                                    }, msg, { forward: true });
                                    
                                    await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });
                                    recordDownload(senderPhone);
                                    try { fs.unlinkSync(filePath); } catch (e) {}
                                    
                                    session.state = 'waiting_for_search';
                                    session.isDownloading = false;
                                    session.searchResults = [];
                                    stopDownloadTracking(senderPhone);
                                    userSessions.set(userId, session);
                                    return;
                                }
                                try { fs.unlinkSync(filePath); } catch (e) {}
                            }
                        }
                    }
                }
            } catch (altError) {
                console.error('[Retry] Alternative source also failed:', altError.message);
            }
            
            // All sources failed - provide direct link fallback
            const directLink = await getDirectDownloadLink(appId, 'APKPure');
            const an1Link = await getDirectDownloadLink(appTitle, 'AN1');
            
            await sock.sendMessage(remoteJid, { react: { text: '⚠️', key: msg.key } });
            await sendBotMessage(sock, remoteJid, { 
                text: `❌ *ماقديتش نحمّل التطبيق*

جربت مصادر متعددة ولكن فشلوا.

🔗 *روابط مباشرة للتحميل:*
◄ APKPure: ${directLink}
◄ AN1: ${an1Link}

💡 افتح أحد الروابط في المتصفح وحمّل مباشرة${POWERED_BY}` 
            }, msg);
            addContext(userId, `❌ فشل تحميل التطبيق "${appTitle}" من جميع المصادر. تم إرسال روابط مباشرة للمستخدم.`);
        }

        session.state = 'waiting_for_search';
        session.isDownloading = false;
        session.searchResults = [];
        stopDownloadTracking(senderPhone);
        userSessions.set(userId, session);
    } catch (error) {
        console.error('❌ مشكل:', error);
        
        // Provide direct link on error as well
        const directLink = await getDirectDownloadLink(appId, 'APKPure');
        
        await sock.sendMessage(remoteJid, { react: { text: '⚠️', key: msg.key } });
        await sendBotMessage(sock, remoteJid, { 
            text: `❌ *وقع مشكل في التحميل*

🔗 *رابط مباشر للتحميل:*
${directLink}

💡 افتح الرابط في المتصفح وحمّل مباشرة${POWERED_BY}` 
        }, msg);
        session.state = 'waiting_for_search';
        session.isDownloading = false;
        session.searchResults = [];
        stopDownloadTracking(senderPhone);
        userSessions.set(userId, session);
    }
}

// Global error handlers to prevent session crashes
process.on('uncaughtException', (err) => {
    console.error('⚠️ Uncaught Exception (لم يتوقف البوت):', err.message);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️ Unhandled Rejection (لم يتوقف البوت):', reason);
});

console.log('🤖 بوت Omar AI المحترف');
console.log('🚀 كنطلق البوت...\n');

await initDatabase();
await downloadBotProfileImage();
await loadPlugins();

connectToWhatsApp().then(sock => {
    if (sock) {
        setupAntiTimeScheduler(sock);
        console.log('✅ تم تفعيل جدولة الإغلاق/الفتح التلقائي للمجموعات');
    }
}).catch(err => {
    console.error('❌ مشكل خطير:', err);
    process.exit(1);
});