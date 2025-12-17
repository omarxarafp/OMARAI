# AppOmar WhatsApp Bot

## Overview

A professional WhatsApp bot built with Node.js that provides multiple features including:
- **APK/App Downloads**: Search and download Android applications from various sources
- **Social Media Downloaders**: Download content from TikTok, Instagram, Twitter/X, Facebook, Pinterest, YouTube
- **File Management**: Large file splitting for WhatsApp's size limits, Google Drive and Mediafire downloads
- **AI Integration**: Google Gemini AI for conversational responses and image generation
- **Group Management**: Anti-link, anti-bad-words, anti-spam features with configurable settings
- **VIP System**: Tiered user permissions with developers, VIP users, and regular users

The bot is bilingual (Arabic/English) with primary focus on Arabic-speaking users.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Core Technologies
- **Runtime**: Node.js with ES Modules
- **WhatsApp Library**: Baileys (@itsukichan/baileys) for WhatsApp Web API connection
- **AI Backend**: Google Generative AI (@google/generative-ai) for Gemini integration
- **API Server**: Python FastAPI server (src/api/api_server.py) for app scraping and downloads
- **Image Processing**: Sharp for image manipulation

### Application Structure
```
├── bot.js                 # Main entry point - WhatsApp connection and message routing
├── config/config.js       # Configuration (API keys, developer phones, bot settings)
├── plugins/               # Feature modules (social downloaders, group admin, etc.)
├── src/
│   ├── api/api_server.py  # Python FastAPI for app downloads
│   ├── storage.js         # JSON-based data persistence
│   ├── group-manager.js   # Group moderation features
│   ├── interactive-buttons.js # WhatsApp interactive UI components
│   └── utils/
│       ├── gemini-brain.js    # AI conversation handling
│       ├── file-splitter.js   # Large file chunking
│       └── gemini-scraper.js  # Gemini web scraping
├── session/               # WhatsApp session credentials (auto-generated)
├── data/                  # Persistent JSON storage
└── conversations/         # User conversation history
```

### Plugin Architecture
Each plugin in `/plugins` exports:
- `name`: Display name
- `patterns`: URL regex patterns for auto-detection
- `commands`: Command triggers (e.g., 'ping', 'owner')
- `handler(sock, remoteJid, text, msg, utils, senderPhone)`: Main handler function

### Message Flow
1. Message received → bot.js routes based on content type
2. URL patterns checked against plugin patterns
3. Commands matched against plugin commands
4. Fallback to Gemini AI for conversational responses

### Data Storage
- **JSON Files**: User data, downloads, blocklist, group settings stored in `/data`
- **Conversation History**: Per-user JSON files in `/conversations`
- **Session Data**: WhatsApp credentials in `/session`
- **PostgreSQL**: Optional database support via DATABASE_URL environment variable (schema in `database/schema.sql`)

### Caching Strategy
- `node-cache` for message retry counters and response deduplication
- File parts cache for split files (10-minute TTL)
- Gemini cookie caching (30-minute TTL)

### Rate Limiting & Error Handling
- Spam detection: Fast message limits, hourly message limits
- Concurrent download limits per user
- Graceful handling of WhatsApp rate limits with exponential backoff
- Global unhandled rejection/exception handlers to prevent crashes

### User Permission Levels
1. **Developers**: Full access, defined in config.developer.phones
2. **VIP Users**: Extended download limits, registered via password
3. **Regular Users**: 1GB download limit, standard features

## External Dependencies

### APIs & Services
- **Google Gemini API**: AI conversations and image analysis (requires GEMINI_API_KEY)
- **WhatsApp Web**: Via Baileys library for messaging
- **Social Media APIs**: Various scraping endpoints for TikTok, Instagram, Twitter, etc.

### Python Dependencies (requirements.txt)
- FastAPI + Uvicorn for API server
- cloudscraper, curl-cffi for anti-bot bypass
- aiohttp, httpx for async HTTP
- BeautifulSoup, trafilatura for web scraping
- psycopg2 for PostgreSQL (optional)

### Node.js Key Dependencies
- @itsukichan/baileys: WhatsApp connection
- @google/generative-ai: Gemini AI
- sharp: Image processing
- axios, undici: HTTP requests
- cheerio: HTML parsing
- pg: PostgreSQL client

### File Storage
- `/app_cache`: Downloaded APK files
- `/tmp/file_splits`: Temporary split file parts

### Environment Variables
- `GEMINI_API_KEY`: Required for AI features
- `DATABASE_URL`: Optional PostgreSQL connection string
- `DOTENV_CONFIG`: Loaded via dotenv/config