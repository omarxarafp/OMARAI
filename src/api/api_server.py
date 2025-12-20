#!/usr/bin/env python3
from fastapi import FastAPI, HTTPException, BackgroundTasks, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
import asyncio
import time
import os
import subprocess
from typing import Optional, Dict, Any, List
import uvicorn
import sys
from contextlib import asynccontextmanager
from datetime import datetime
import aiohttp
import aiofiles
import httpx
import cloudscraper
import re
from bs4 import BeautifulSoup
import requests
from urllib.parse import quote_plus
import trafilatura
from curl_cffi import requests as curl_requests

DOWNLOADS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), 'app_cache')
os.makedirs(DOWNLOADS_DIR, exist_ok=True)

APKEEP_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), 'apkeep')

scraper = cloudscraper.create_scraper(
    browser={
        'browser': 'chrome',
        'platform': 'android',
        'mobile': True
    }
)

httpx_client: Optional[httpx.AsyncClient] = None

async def get_httpx_client() -> httpx.AsyncClient:
    global httpx_client
    if httpx_client is None:
        httpx_client = httpx.AsyncClient(
            timeout=30.0,
            follow_redirects=True,
            headers={
                'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
                'Sec-CH-UA-Mobile': '?1',
            }
        )
    return httpx_client

async def fetch_with_protection(url: str, use_cloudscraper: bool = True) -> Optional[str]:
    """Fetch URL with anti-bot protection bypass using mobile headers"""
    mobile_headers = {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Sec-CH-UA': '"Chromium";v="120", "Google Chrome";v="120", "Not_A Brand";v="99"',
        'Sec-CH-UA-Mobile': '?1',
        'Sec-CH-UA-Platform': '"Android"',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-User': '?1',
        'Sec-Fetch-Dest': 'document',
        'Upgrade-Insecure-Requests': '1',
    }
    
    if use_cloudscraper:
        try:
            loop = asyncio.get_event_loop()
            response = await loop.run_in_executor(
                None,
                lambda: scraper.get(url, headers=mobile_headers, timeout=20)
            )
            if response.status_code == 200:
                print(f"[CloudScraper] Success", file=sys.stderr)
                return response.text
        except Exception as e:
            print(f"[CloudScraper] Failed: {e}", file=sys.stderr)
    
    try:
        client = await get_httpx_client()
        response = await client.get(url, headers=mobile_headers)
        if response.status_code == 200:
            print(f"[httpx] Success", file=sys.stderr)
            return response.text
    except Exception as e:
        print(f"[httpx] Failed: {e}", file=sys.stderr)
    
    try:
        loop = asyncio.get_event_loop()
        response = await loop.run_in_executor(
            None,
            lambda: requests.get(url, headers=mobile_headers, timeout=15)
        )
        if response.status_code == 200:
            print(f"[requests] Success", file=sys.stderr)
            return response.text
    except Exception as e:
        print(f"[requests] Failed: {e}", file=sys.stderr)
    
    return None

async def download_with_aria2(url: str, output_path: str, filename: str) -> Optional[str]:
    """Download file using aria2c with multiple connections for speed"""
    try:
        print(f"[aria2] Downloading with 16 connections...", file=sys.stderr)
        start_time = time.time()
        
        result = subprocess.run(
            [
                'aria2c',
                '-x', '16',
                '-s', '16', 
                '-k', '1M',
                '--max-connection-per-server=16',
                '--min-split-size=1M',
                '--file-allocation=none',
                '--continue=true',
                '-d', output_path,
                '-o', filename,
                '--timeout=120',
                '--connect-timeout=30',
                url
            ],
            capture_output=True,
            text=True,
            timeout=300
        )
        
        elapsed = time.time() - start_time
        file_path = os.path.join(output_path, filename)
        
        if os.path.exists(file_path) and os.path.getsize(file_path) > 100000:
            size_mb = os.path.getsize(file_path) / (1024 * 1024)
            print(f"[aria2] Downloaded: {size_mb:.1f} MB in {elapsed:.1f}s", file=sys.stderr)
            return file_path
        
        print(f"[aria2] Failed: {result.stderr}", file=sys.stderr)
        return None
        
    except subprocess.TimeoutExpired:
        print(f"[aria2] Timeout", file=sys.stderr)
        return None
    except Exception as e:
        print(f"[aria2] Error: {e}", file=sys.stderr)
        return None

import zipfile
import io

def detect_real_file_type(file_path: str) -> str:
    """Detect actual file type by inspecting ZIP contents"""
    try:
        with zipfile.ZipFile(file_path, 'r') as zf:
            names = zf.namelist()
            names_lower = [n.lower() for n in names]
            
            if 'manifest.json' in names_lower:
                print(f"[Type Detect] Found manifest.json - this is XAPK", file=sys.stderr)
                return 'xapk'
            
            has_apk = any(n.endswith('.apk') for n in names_lower)
            has_obb = any('.obb' in n for n in names_lower)
            
            if has_apk or has_obb:
                print(f"[Type Detect] Found APK/OBB inside - this is XAPK", file=sys.stderr)
                return 'xapk'
            
            if 'androidmanifest.xml' in names_lower:
                print(f"[Type Detect] Found AndroidManifest.xml at root - this is APK", file=sys.stderr)
                return 'apk'
            
            if 'classes.dex' in names_lower or 'resources.arsc' in names_lower:
                print(f"[Type Detect] Found APK structure - this is APK", file=sys.stderr)
                return 'apk'
            
            print(f"[Type Detect] Unknown structure, files: {names[:5]}", file=sys.stderr)
            return 'apk'
            
    except zipfile.BadZipFile:
        print(f"[Type Detect] Not a valid ZIP file", file=sys.stderr)
        return 'apk'
    except Exception as e:
        print(f"[Type Detect] Error: {e}", file=sys.stderr)
        return 'apk'

async def download_from_apkpure(package_name: str, output_dir: str) -> Optional[str]:
    """Download from APKPure and detect real file type from content"""
    try:
        temp_filename = f"{package_name}.tmp"
        download_url = f"https://d.apkpure.com/b/XAPK/{package_name}?version=latest"
        
        print(f"[APKPure] Downloading {package_name}...", file=sys.stderr)
        result = await download_with_aria2(download_url, output_dir, temp_filename)
        
        if not result or not os.path.exists(result) or os.path.getsize(result) < 100000:
            download_url = f"https://d.apkpure.com/b/APK/{package_name}?version=latest"
            print(f"[APKPure] XAPK failed, trying APK endpoint...", file=sys.stderr)
            result = await download_with_aria2(download_url, output_dir, temp_filename)
        
        if not result or not os.path.exists(result) or os.path.getsize(result) < 100000:
            print(f"[APKPure] Download failed for {package_name}", file=sys.stderr)
            return None
        
        real_type = detect_real_file_type(result)
        final_filename = f"{package_name}.{real_type}"
        final_path = os.path.join(output_dir, final_filename)
        
        if result != final_path:
            os.rename(result, final_path)
            print(f"[APKPure] Renamed to: {final_filename}", file=sys.stderr)
        
        return final_path
        
    except Exception as e:
        print(f"[APKPure] Error: {e}", file=sys.stderr)
        return None

not_found_cache: Dict[str, float] = {}
NOT_FOUND_CACHE_TTL = 3600

async def search_modyolo(query: str, num_results: int = 10) -> List[Dict[str, Any]]:
    """Search MODYOLO for modded APKs - tries direct URL construction"""
    try:
        print(f"[MODYOLO] Searching: {query}", file=sys.stderr)
        
        all_apps = []
        loop = asyncio.get_event_loop()
        
        scraper = cloudscraper.create_scraper(browser={'browser': 'chrome', 'platform': 'android', 'mobile': True})
        
        def fetch_page(url):
            try:
                resp = scraper.get(url, timeout=20)
                return (resp.status_code, resp.text) if resp.status_code == 200 else (resp.status_code, '')
            except Exception as e:
                print(f"[MODYOLO] Fetch error: {e}", file=sys.stderr)
                return (0, '')
        
        def extract_app_info(html, url):
            if not html:
                return None
            soup = BeautifulSoup(html, 'html.parser')
            
            title_el = soup.find('h1') or soup.find('title')
            title = title_el.get_text(strip=True) if title_el else ''
            title = re.sub(r'\s*[-–|].*$', '', title).strip()
            
            img = soup.find('img', class_=re.compile(r'wp-post-image|featured|thumb|icon'))
            if not img:
                img = soup.select_one('.entry-content img, .post-thumbnail img, article img')
            icon = str(img.get('src') or img.get('data-src') or '') if img else ''
            
            text = soup.get_text()
            version_match = re.search(r'Version[:\s]*(\d+\.\d+(?:\.\d+)*)', text, re.IGNORECASE)
            version = version_match.group(1) if version_match else ''
            
            size_match = re.search(r'Size[:\s]*(\d+(?:\.\d+)?\s*(?:MB|GB|M|G))', text, re.IGNORECASE)
            size = size_match.group(1) if size_match else ''
            
            mod_match = re.search(r'(Unlimited|Premium|Unlocked|Mega Menu|VIP|Pro|Full|Mod Menu|Free Shopping|No Ads)[^\n<]*', text, re.IGNORECASE)
            mod_info = mod_match.group(0).strip()[:50] if mod_match else 'MOD'
            
            return {
                "title": title + " (مهكرة)",
                "url": url,
                "icon": icon,
                "source": "MODYOLO",
                "isMod": True,
                "version": version,
                "size": size,
                "modInfo": mod_info
            }
        
        query_slug = query.lower().strip()
        query_slug = re.sub(r'[^a-z0-9\s-]', '', query_slug)
        query_slug = re.sub(r'\s+', '-', query_slug)
        
        url_variations = [
            f'https://modyolo.com/{query_slug}.html',
            f'https://modyolo.com/{query_slug.replace("-", "")}.html',
        ]
        
        words = query.lower().split()
        if len(words) > 1:
            url_variations.append(f'https://modyolo.com/{words[0]}.html')
            url_variations.append(f'https://modyolo.com/{"-".join(words[:2])}.html')
        
        print(f"[MODYOLO] Trying direct URLs: {url_variations}", file=sys.stderr)
        
        seen_urls = set()
        for url in url_variations:
            if url in seen_urls:
                continue
            seen_urls.add(url)
            
            status, html = await loop.run_in_executor(None, lambda u=url: fetch_page(u))
            if status == 200 and html:
                app_info = extract_app_info(html, url)
                if app_info and app_info['title']:
                    all_apps.append(app_info)
                    print(f"[MODYOLO] Found: {app_info['title']}", file=sys.stderr)
                    
                    soup = BeautifulSoup(html, 'html.parser')
                    related = soup.find_all('a', href=re.compile(r'modyolo\.com/[a-z0-9-]+\.html'))
                    for rel in related[:5]:
                        rel_url = rel.get('href', '')
                        if rel_url and rel_url not in seen_urls and '/download/' not in rel_url:
                            seen_urls.add(rel_url)
                            rel_title = rel.get_text(strip=True)
                            if rel_title and len(rel_title) > 2:
                                all_apps.append({
                                    "title": rel_title + " (مهكرة)",
                                    "url": rel_url,
                                    "icon": "",
                                    "source": "MODYOLO",
                                    "isMod": True,
                                    "version": "",
                                    "size": "",
                                    "modInfo": "MOD"
                                })
        
        print(f"[MODYOLO] Total apps found: {len(all_apps)}", file=sys.stderr)
        
        if not all_apps:
            print(f"[MODYOLO] No results found for '{query}'", file=sys.stderr)
            return []
        
        results = all_apps[:num_results]
        print(f"[MODYOLO] Returning {len(results)} results", file=sys.stderr)
        return results
        
    except Exception as e:
        print(f"[MODYOLO] Error: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        return []

async def get_modyolo_download_link(page_url: str) -> Optional[Dict[str, Any]]:
    """Extract download link from MODYOLO page"""
    try:
        loop = asyncio.get_event_loop()
        headers = {
            'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
        }
        
        print(f"[MODYOLO] Fetching app page: {page_url}", file=sys.stderr)
        
        scraper = cloudscraper.create_scraper(browser={'browser': 'chrome', 'platform': 'android', 'mobile': True})
        html = await loop.run_in_executor(
            None,
            lambda: scraper.get(page_url, headers=headers, timeout=30).text
        )
        
        if not html:
            print(f"[MODYOLO] Failed to fetch page", file=sys.stderr)
            return None
        
        soup = BeautifulSoup(html, 'html.parser')
        
        download_link = None
        download_links = soup.find_all('a', href=re.compile(r'/download/[^/]+-\d+'))
        
        for link in download_links:
            href = str(link.get('href', '') or '')
            if href:
                if not href.startswith('http'):
                    href = 'https://modyolo.com' + href
                download_link = href
                break
        
        if download_link:
            print(f"[MODYOLO] Found download page: {download_link}", file=sys.stderr)
            
            dl_html = await loop.run_in_executor(
                None,
                lambda url=download_link: requests.get(url, headers=headers, timeout=20).text
            )
            
            if dl_html:
                dl_soup = BeautifulSoup(dl_html, 'html.parser')
                
                final_links = dl_soup.find_all('a', href=re.compile(r'/download/[^/]+-\d+/\d+'))
                
                if final_links:
                    first_link = str(final_links[0].get('href', '') or '')
                    if first_link and not first_link.startswith('http'):
                        first_link = 'https://modyolo.com' + first_link
                    
                    size_text = str(final_links[0].get_text() or '')
                    size_match = re.search(r'(\d+(?:\.\d+)?\s*(?:MB|GB|M|G))', size_text, re.IGNORECASE)
                    size = size_match.group(1) if size_match else ''
                    
                    return {
                        "download_url": first_link,
                        "source": "MODYOLO",
                        "page_url": page_url,
                        "size": size,
                        "note": "Click download link to get APK"
                    }
        
        print(f"[MODYOLO] No download link found", file=sys.stderr)
        return None
        
    except Exception as e:
        print(f"[MODYOLO Download] Error: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        return None

async def search_getmodsapk(query: str, num_results: int = 10) -> List[Dict[str, Any]]:
    """Search GetModsAPK for modded APKs"""
    try:
        print(f"[GetModsAPK] Searching: {query}", file=sys.stderr)
        search_url = f"https://getmodsapk.com/search?query={quote_plus(query)}"
        
        loop = asyncio.get_event_loop()
        response = await loop.run_in_executor(
            None,
            lambda: curl_requests.get(search_url, impersonate='chrome', timeout=20)
        )
        
        if response.status_code != 200:
            print(f"[GetModsAPK] Failed with status {response.status_code}", file=sys.stderr)
            return []
        
        html = response.text
        soup = BeautifulSoup(html, 'html.parser')
        results = []
        seen_urls = set()
        
        app_pattern = re.compile(r'getmodsapk\.com/[a-z0-9-]+-(?:mod-)?apk/?$')
        app_links = soup.find_all('a', href=app_pattern)
        
        for a in app_links:
            if len(results) >= num_results:
                break
                
            href = a.get('href', '')
            if not href or href in seen_urls:
                continue
            seen_urls.add(href)
            
            parent = a.find_parent(['div', 'li', 'section'])
            if not parent:
                continue
            
            text = parent.get_text()
            
            slug = href.rstrip('/').split('/')[-1]
            title = slug.replace('-mod-free-apk', '').replace('-mod-apk', '').replace('-apk', '').replace('-', ' ').title()
            title = re.sub(r'^\d+\s*', '', title).strip()
            
            img = parent.find('img') or a.find('img')
            icon = ''
            if img:
                icon = img.get('src') or img.get('data-src') or ''
            
            version = ''
            size = ''
            mod_info = 'MOD'
            
            version_match = re.search(r'v?(\d+\.\d+\.\d+(?:\.\d+)?)', text)
            if version_match:
                version = version_match.group(1)
            
            size_match = re.search(r'Size:?\s*(\d+(?:\.\d+)?\s*(?:MB|GB))', text, re.IGNORECASE)
            if size_match:
                size = size_match.group(1)
            
            mod_match = re.search(r'(Unlimited|Premium|Unlocked|God Mode|Money|VIP|Pro|Full|Mega)', text, re.IGNORECASE)
            if mod_match:
                mod_info = mod_match.group(1)
            
            results.append({
                "title": title + " (مهكرة)",
                "url": href,
                "icon": icon,
                "source": "GetModsAPK",
                "isMod": True,
                "version": version,
                "size": size,
                "modInfo": mod_info
            })
        
        print(f"[GetModsAPK] Found {len(results)} results", file=sys.stderr)
        return results
        
    except Exception as e:
        print(f"[GetModsAPK] Error: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        return []

async def get_getmodsapk_download_link(page_url: str) -> Optional[Dict[str, Any]]:
    """Extract download link from GetModsAPK page"""
    try:
        loop = asyncio.get_event_loop()
        
        if not page_url.endswith('/'):
            page_url = page_url + '/'
        download_page_url = page_url + 'download'
        
        print(f"[GetModsAPK] Fetching download page: {download_page_url}", file=sys.stderr)
        
        response = await loop.run_in_executor(
            None,
            lambda: curl_requests.get(download_page_url, impersonate='chrome', timeout=20)
        )
        
        if response.status_code != 200:
            print(f"[GetModsAPK] Download page failed with status {response.status_code}", file=sys.stderr)
            return None
        
        soup = BeautifulSoup(response.text, 'html.parser')
        
        download_variants = []
        variant_pattern = re.compile(r'/download/\d+')
        variant_links = soup.find_all('a', href=variant_pattern)
        
        for link in variant_links:
            href = link.get('href', '')
            text = link.get_text(strip=True)
            if href:
                full_url = href if href.startswith('http') else f"https://getmodsapk.com{href}"
                download_variants.append({
                    "url": full_url,
                    "name": text or "Download APK"
                })
        
        if download_variants:
            first_variant = download_variants[0]["url"]
            if not first_variant.endswith('/'):
                first_variant += '/'
            
            print(f"[GetModsAPK] Fetching variant: {first_variant}", file=sys.stderr)
            
            variant_response = await loop.run_in_executor(
                None,
                lambda: curl_requests.get(first_variant, impersonate='chrome', timeout=20)
            )
            
            if variant_response.status_code == 200:
                variant_soup = BeautifulSoup(variant_response.text, 'html.parser')
                
                direct_links = variant_soup.find_all('a', href=re.compile(r'\.apk|5modapk\.com|cdn', re.I))
                for link in direct_links:
                    href = link.get('href', '')
                    if href.startswith('http') and any(x in href.lower() for x in ['.apk', '5modapk', 'cdn']):
                        text = link.get_text(strip=True)
                        size_match = re.search(r'(\d+(?:\.\d+)?\s*(?:MB|GB))', text, re.I)
                        size = size_match.group(1) if size_match else ''
                        
                        print(f"[GetModsAPK] Found direct download: {href[:80]}", file=sys.stderr)
                        return {
                            "download_url": href,
                            "all_variants": download_variants,
                            "source": "GetModsAPK",
                            "page_url": page_url,
                            "size": size,
                            "note": "Direct APK download"
                        }
        
        print(f"[GetModsAPK] No download links found", file=sys.stderr)
        return None
        
    except Exception as e:
        print(f"[GetModsAPK Download] Error: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        return None

async def search_traidsoft(query: str, num_results: int = 10) -> List[Dict[str, Any]]:
    """Search traidsoft.net for modded APKs and apps"""
    try:
        print(f"[TraidSoft] Searching: {query}", file=sys.stderr)
        search_url = f"https://app.traidsoft.net/?s={quote_plus(query)}"
        
        headers = {
            'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'ar,en-US;q=0.9,en;q=0.8',
        }
        
        loop = asyncio.get_event_loop()
        html = await loop.run_in_executor(
            None,
            lambda: requests.get(search_url, headers=headers, timeout=20).text
        )
        
        if not html:
            print(f"[TraidSoft] Failed to fetch search page", file=sys.stderr)
            return []
        
        soup = BeautifulSoup(html, 'html.parser')
        results = []
        seen_urls = set()
        
        app_links = soup.find_all('a', href=re.compile(r'app\.traidsoft\.net/download-[a-z0-9-]+/?'))
        
        for a in app_links:
            if len(results) >= num_results:
                break
                
            href = a.get('href', '')
            if not href or href in seen_urls:
                continue
            
            if '/mod-apps/' in href or '/page/' in href or '/category/' in href:
                seen_urls.add(href)
            
            seen_urls.add(href)
            
            title = a.get('title') or a.get_text(strip=True)
            if not title or len(title) < 3:
                slug = href.rstrip('/').split('/')[-1]
                title = slug.replace('-', ' ').title()
            
            if not title or len(title) < 3:
                continue
            
            parent = a.find_parent(['div', 'li', 'article'])
            img = a.find('img') or (parent.find('img') if parent else None)
            icon = ''
            if img:
                icon_src = img.get('src') or img.get('data-src') or img.get('data-lazy-src') or ''
                if icon_src:
                    icon = icon_src
            
            slug = href.rstrip('/').split('/')[-1]
            
            results.append({
                "title": title + " (مهكرة)",
                "url": href if href.startswith('http') else f"https://app.traidsoft.net{href}",
                "appId": slug,
                "icon": icon,
                "source": "TraidSoft",
                "isMod": True
            })
        
        print(f"[TraidSoft] Found {len(results)} results", file=sys.stderr)
        return results
        
    except Exception as e:
        print(f"[TraidSoft] Search error: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        return []

async def get_traidsoft_download_link(page_url: str) -> Optional[Dict[str, Any]]:
    """Extract download links from TraidSoft page"""
    try:
        print(f"[TraidSoft] Getting download link from: {page_url}", file=sys.stderr)
        
        headers = {
            'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'ar,en-US;q=0.9,en;q=0.8',
            'Referer': page_url,
        }
        
        loop = asyncio.get_event_loop()
        html = await loop.run_in_executor(
            None,
            lambda: requests.get(page_url, headers=headers, timeout=20).text
        )
        
        if not html:
            print(f"[TraidSoft] Failed to fetch page, returning page URL", file=sys.stderr)
            return {
                "download_url": page_url,
                "source": "TraidSoft",
                "page_url": page_url,
                "note": "زيارة الصفحة مباشرة للحصول على رابط التحميل"
            }
        
        soup = BeautifulSoup(html, 'html.parser')
        download_links = []
        
        mediafire_links = soup.find_all('a', href=re.compile(r'mediafire\.com'))
        for link in mediafire_links:
            href = link.get('href', '')
            text = link.get_text(strip=True) or 'MediaFire Download'
            if href and href.startswith('http'):
                download_links.append({
                    "url": href,
                    "name": text,
                    "type": "mediafire"
                })
        
        mega_links = soup.find_all('a', href=re.compile(r'mega\.nz'))
        for link in mega_links:
            href = link.get('href', '')
            text = link.get_text(strip=True) or 'MEGA Download'
            if href and href.startswith('http'):
                download_links.append({
                    "url": href,
                    "name": text,
                    "type": "mega"
                })
        
        direct_apk_links = soup.find_all('a', href=re.compile(r'\.apk(\?|$)', re.IGNORECASE))
        for link in direct_apk_links:
            href = link.get('href', '')
            text = link.get_text(strip=True) or 'Direct APK'
            if href:
                if not href.startswith('http'):
                    href = 'https://app.traidsoft.net' + (href if href.startswith('/') else '/' + href)
                download_links.append({
                    "url": href,
                    "name": text,
                    "type": "direct"
                })
        
        if download_links:
            primary_link = None
            for dl in download_links:
                if dl['type'] == 'mediafire':
                    primary_link = dl['url']
                    break
            
            if not primary_link and download_links:
                for dl in download_links:
                    if dl['type'] in ['direct', 'mega']:
                        primary_link = dl['url']
                        break
            
            if not primary_link and download_links:
                primary_link = download_links[0]['url']
            
            print(f"[TraidSoft] Found {len(download_links)} download links", file=sys.stderr)
            return {
                "download_url": primary_link,
                "all_links": download_links,
                "source": "TraidSoft",
                "page_url": page_url
            }
        
        print(f"[TraidSoft] No direct links found, returning page URL", file=sys.stderr)
        return {
            "download_url": page_url,
            "source": "TraidSoft",
            "page_url": page_url,
            "note": "زيارة الصفحة مباشرة للحصول على رابط التحميل"
        }
        
    except Exception as e:
        print(f"[TraidSoft] Download error: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        return None

MOD_SOURCES = [
    {"name": "AN1", "search_url": "https://an1.com/?do=search&subaction=search&story={query}", "base_url": "https://an1.com"},
]

async def search_an1(query: str, num_results: int = 10) -> List[Dict[str, Any]]:
    """Search AN1.com for modded APKs"""
    try:
        print(f"[AN1] Searching: {query}", file=sys.stderr)
        search_url = f"https://an1.com/?do=search&subaction=search&story={quote_plus(query)}"
        
        headers = {
            'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
        }
        
        loop = asyncio.get_event_loop()
        html = await loop.run_in_executor(
            None,
            lambda: requests.get(search_url, headers=headers, timeout=20).text
        )
        
        if not html:
            print(f"[AN1] Failed to fetch search page", file=sys.stderr)
            return []
        
        soup = BeautifulSoup(html, 'html.parser')
        results = []
        seen_urls = set()
        
        game_links = soup.find_all('a', href=re.compile(r'an1\.com/\d+-[^/]+\.html'))
        
        for a in game_links:
            if len(results) >= num_results:
                break
                
            href = a.get('href', '')
            if not href or href in seen_urls:
                continue
            seen_urls.add(href)
            
            title = a.get('title') or a.get_text(strip=True)
            if not title or len(title) < 3:
                continue
            
            id_match = re.search(r'/(\d+)-([^/]+)\.html', href)
            if not id_match:
                continue
            
            app_id = id_match.group(1)
            
            parent = a.find_parent(['div', 'li', 'article'])
            img = a.find('img') or (parent.find('img') if parent else None)
            icon = ''
            if img:
                icon = img.get('src') or img.get('data-src') or ''
            
            developer = ''
            if parent:
                dev_el = parent.find(text=re.compile(r'^[A-Z][\w\s]+$'))
                if dev_el:
                    developer = str(dev_el).strip()
            
            rating = 0.0
            if parent:
                rating_el = parent.find(class_=re.compile(r'rating|score'))
                if rating_el:
                    try:
                        rating = float(re.search(r'[\d.]+', rating_el.get_text()).group())
                    except:
                        pass
            
            size_match = re.search(r'([\d.]+)\s*(?:Mb|MB|Gb|GB)', str(parent) if parent else '')
            size = size_match.group(0) if size_match else ''
            
            results.append({
                "title": title + " (مهكرة)",
                "originalTitle": title,
                "url": href if href.startswith('http') else f"https://an1.com{href}",
                "appId": app_id,
                "icon": icon,
                "developer": developer,
                "rating": rating,
                "size": size,
                "source": "AN1",
                "isMod": True
            })
        
        print(f"[AN1] Found {len(results)} results", file=sys.stderr)
        return results
        
    except Exception as e:
        print(f"[AN1] Search error: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        return []

async def get_an1_download_link(page_url: str) -> Optional[Dict[str, Any]]:
    """Extract direct download link from AN1.com page"""
    try:
        print(f"[AN1] Getting download link from: {page_url}", file=sys.stderr)
        
        id_match = re.search(r'/(\d+)-([^/]+)\.html', page_url)
        if not id_match:
            print(f"[AN1] Could not extract app ID from URL", file=sys.stderr)
            return None
        
        app_id = id_match.group(1)
        download_page_url = f"https://an1.com/file_{app_id}-dw.html"
        
        headers = {
            'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': page_url,
        }
        
        loop = asyncio.get_event_loop()
        html = await loop.run_in_executor(
            None,
            lambda: requests.get(download_page_url, headers=headers, timeout=20).text
        )
        
        if not html:
            print(f"[AN1] Failed to fetch download page", file=sys.stderr)
            return None
        
        all_links = re.findall(r'(https://(?:files\.an1\.(?:co|net)|an1\.online/files)/[^"\'<>\s]+\.apk)', html)
        download_url = None
        for link in all_links:
            if 'an1store' not in link.lower():
                download_url = link
                break
        
        if download_url:
            print(f"[AN1] Found download: {download_url}", file=sys.stderr)
            
            size_match = re.search(r'([\d.]+)\s*(?:Mb|MB|Gb|GB)', html)
            size = size_match.group(0) if size_match else ''
            
            version_match = re.search(r'[\d.]+(?=\.apk|[_-]an1)', download_url)
            version = version_match.group(0) if version_match else ''
            
            return {
                "download_url": download_url,
                "source": "AN1",
                "page_url": page_url,
                "size": size,
                "version": version
            }
        
        dl_match = re.search(r'href=["\']([^"\']*(?:files\.an1\.co|an1\.online/files)[^"\']+\.apk)["\']', html)
        if dl_match:
            download_url = dl_match.group(1)
            if 'an1store' not in download_url.lower():
                print(f"[AN1] Found download link: {download_url}", file=sys.stderr)
                return {
                    "download_url": download_url,
                    "source": "AN1",
                    "page_url": page_url
                }
        
        print(f"[AN1] No download link found", file=sys.stderr)
        return None
        
    except Exception as e:
        print(f"[AN1] Download error: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        return None

async def search_gamessapk(query: str, num_results: int = 10) -> List[Dict[str, Any]]:
    """Search GamesAPK.com for games APKs (Arabic games site)"""
    try:
        print(f"[GamesAPK] Searching: {query}", file=sys.stderr)
        search_url = f"https://gamessapk.com/?s={quote_plus(query)}"
        
        headers = {
            'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'ar,en-US;q=0.9,en;q=0.8',
        }
        
        loop = asyncio.get_event_loop()
        html = await loop.run_in_executor(
            None,
            lambda: requests.get(search_url, headers=headers, timeout=20).text
        )
        
        if not html:
            print(f"[GamesAPK] Failed to fetch search page", file=sys.stderr)
            return []
        
        soup = BeautifulSoup(html, 'html.parser')
        results = []
        seen_urls = set()
        
        game_links = soup.find_all('a', href=re.compile(r'gamessapk\.com/[a-z0-9-]+/?$'))
        
        for a in game_links:
            if len(results) >= num_results:
                break
                
            href = a.get('href', '')
            if not href or href in seen_urls or href == 'https://gamessapk.com/':
                continue
            
            if '/page/' in href or '/category/' in href or '?s=' in href:
                continue
            
            excluded_pages = ['privacy-policy', 'terms-of-use', 'contact-us', 'about-us', 'dmca', 'disclaimer']
            slug = href.rstrip('/').split('/')[-1]
            if slug in excluded_pages:
                continue
                
            seen_urls.add(href)
            
            title = a.get('title') or ''
            if not title:
                title = a.get_text(strip=True)
            
            if not title or len(title) < 3:
                slug = href.rstrip('/').split('/')[-1]
                title = slug.replace('-', ' ').title()
            
            if not title or len(title) < 3:
                continue
            
            title = re.sub(r'^تحميل\s*(لعبة\s*)?', '', title).strip()
            title = re.sub(r'\s+للاندرويد.*$', '', title, flags=re.IGNORECASE).strip()
            title = re.sub(r'\s+APK.*$', '', title, flags=re.IGNORECASE).strip()
            
            parent = a.find_parent(['div', 'li', 'article'])
            img = a.find('img') or (parent.find('img') if parent else None)
            icon = ''
            if img:
                icon_src = img.get('src') or img.get('data-src') or img.get('data-lazy-src') or ''
                if icon_src:
                    icon = icon_src.replace('-150x150', '').replace('-300x300', '')
            
            slug = href.rstrip('/').split('/')[-1]
            
            results.append({
                "title": title,
                "url": href if href.startswith('http') else f"https://gamessapk.com{href}",
                "appId": slug,
                "icon": icon,
                "source": "GamesAPK",
                "isMod": False,
                "isGame": True
            })
        
        print(f"[GamesAPK] Found {len(results)} results", file=sys.stderr)
        return results
        
    except Exception as e:
        print(f"[GamesAPK] Search error: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        return []

async def get_gamessapk_download_link(page_url: str) -> Optional[Dict[str, Any]]:
    """Extract download links from GamesAPK page"""
    try:
        print(f"[GamesAPK] Getting download link from: {page_url}", file=sys.stderr)
        
        if '?download=links' not in page_url:
            download_page_url = page_url.rstrip('/') + '/?download=links'
        else:
            download_page_url = page_url
        
        headers = {
            'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'ar,en-US;q=0.9,en;q=0.8',
            'Referer': page_url,
        }
        
        loop = asyncio.get_event_loop()
        html = await loop.run_in_executor(
            None,
            lambda: requests.get(download_page_url, headers=headers, timeout=20).text
        )
        
        if not html:
            print(f"[GamesAPK] Failed to fetch download page", file=sys.stderr)
            return None
        
        soup = BeautifulSoup(html, 'html.parser')
        download_links = []
        
        mediafire_links = soup.find_all('a', href=re.compile(r'mediafire\.com/file'))
        for link in mediafire_links:
            href = link.get('href', '')
            text = link.get_text(strip=True) or 'MediaFire Download'
            if href:
                download_links.append({
                    "url": href,
                    "name": text,
                    "type": "mediafire"
                })
        
        playstore_links = soup.find_all('a', href=re.compile(r'play\.google\.com/store/apps'))
        for link in playstore_links:
            href = link.get('href', '')
            text = link.get_text(strip=True) or 'Google Play'
            if href:
                pkg_match = re.search(r'id=([a-zA-Z0-9_.]+)', href)
                package_id = pkg_match.group(1) if pkg_match else ''
                download_links.append({
                    "url": href,
                    "name": text,
                    "type": "playstore",
                    "packageId": package_id
                })
        
        mega_links = soup.find_all('a', href=re.compile(r'mega\.nz'))
        for link in mega_links:
            href = link.get('href', '')
            text = link.get_text(strip=True) or 'MEGA Download'
            if href:
                download_links.append({
                    "url": href,
                    "name": text,
                    "type": "mega"
                })
        
        drive_links = soup.find_all('a', href=re.compile(r'drive\.google\.com'))
        for link in drive_links:
            href = link.get('href', '')
            text = link.get_text(strip=True) or 'Google Drive'
            if href:
                download_links.append({
                    "url": href,
                    "name": text,
                    "type": "gdrive"
                })
        
        direct_apk_links = soup.find_all('a', href=re.compile(r'\.apk(\?|$)'))
        for link in direct_apk_links:
            href = link.get('href', '')
            text = link.get_text(strip=True) or 'Direct APK'
            if href and href.startswith('http'):
                download_links.append({
                    "url": href,
                    "name": text,
                    "type": "direct"
                })
        
        if download_links:
            primary_link = None
            for dl in download_links:
                if dl['type'] == 'mediafire':
                    primary_link = dl['url']
                    break
            
            if not primary_link and download_links:
                for dl in download_links:
                    if dl['type'] in ['direct', 'gdrive', 'mega']:
                        primary_link = dl['url']
                        break
            
            if not primary_link and download_links:
                primary_link = download_links[0]['url']
            
            print(f"[GamesAPK] Found {len(download_links)} download links", file=sys.stderr)
            return {
                "download_url": primary_link,
                "all_links": download_links,
                "source": "GamesAPK",
                "page_url": page_url,
                "note": "تحميل من GamesAPK"
            }
        
        print(f"[GamesAPK] No download links found", file=sys.stderr)
        return None
        
    except Exception as e:
        print(f"[GamesAPK] Download error: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        return None

async def get_mega_download_info(mega_url: str) -> Optional[Dict[str, Any]]:
    """Get MEGA.nz file info and direct download link using public API"""
    try:
        print(f"[MEGA] Processing: {mega_url}", file=sys.stderr)
        
        file_id = None
        file_key = None
        
        if '/file/' in mega_url:
            match = re.search(r'/file/([^#]+)#?(.+)?', mega_url)
            if match:
                file_id = match.group(1)
                file_key = match.group(2) if match.group(2) else None
        elif '/#!' in mega_url or '/!' in mega_url:
            match = re.search(r'[/#]!([^!]+)!?(.+)?', mega_url)
            if match:
                file_id = match.group(1)
                file_key = match.group(2) if match.group(2) else None
        
        if not file_id:
            print(f"[MEGA] Could not extract file ID", file=sys.stderr)
            return None
        
        api_url = "https://g.api.mega.co.nz/cs"
        payload = [{"a": "g", "g": 1, "ssl": 0, "p": file_id}]
        
        loop = asyncio.get_event_loop()
        response = await loop.run_in_executor(
            None,
            lambda: requests.post(api_url, json=payload, timeout=30)
        )
        
        if response.status_code != 200:
            print(f"[MEGA] API error: {response.status_code}", file=sys.stderr)
            return None
        
        data = response.json()
        if isinstance(data, list) and len(data) > 0:
            result = data[0]
            if isinstance(result, dict) and 'g' in result:
                download_url = result['g']
                file_size = result.get('s', 0)
                
                print(f"[MEGA] Success - Size: {file_size} bytes", file=sys.stderr)
                return {
                    "download_url": download_url,
                    "file_size": file_size,
                    "file_id": file_id,
                    "original_url": mega_url,
                    "source": "MEGA",
                    "note": "Direct download link (temporary, encrypted)"
                }
            elif isinstance(result, int):
                error_codes = {-1: "Internal error", -2: "Invalid args", -3: "Retry", -9: "Not found", -13: "Link disabled"}
                print(f"[MEGA] Error: {error_codes.get(result, 'Unknown error')} ({result})", file=sys.stderr)
        
        return None
        
    except Exception as e:
        print(f"[MEGA] Error: {e}", file=sys.stderr)
        return None

async def search_mod_apk(query: str, num_results: int = 10) -> List[Dict[str, Any]]:
    """Search for modded APKs - uses MODYOLO as primary source"""
    results = await search_modyolo(query, num_results)
    if results:
        return results
    
    for source in MOD_SOURCES:
        try:
            search_url = source["search_url"].format(query=quote_plus(query))
            html = await fetch_with_protection(search_url, use_cloudscraper=True)
            
            if not html:
                continue
                
            soup = BeautifulSoup(html, 'html.parser')
            
            if source["name"] == "APKMody":
                items = soup.select('article.post, .search-result-item, .game-item')[:num_results]
                for item in items:
                    title_el = item.select_one('h2 a, h3 a, .title a, a.title')
                    if title_el:
                        title = title_el.get_text(strip=True)
                        link = title_el.get('href', '')
                        if link and not link.startswith('http'):
                            link = source["base_url"] + link
                        
                        img_el = item.select_one('img')
                        icon = img_el.get('src', '') if img_el else ''
                        
                        desc_el = item.select_one('.excerpt, .description, p')
                        desc = desc_el.get_text(strip=True)[:100] if desc_el else ''
                        
                        results.append({
                            "title": title,
                            "source": source["name"],
                            "url": link,
                            "icon": icon,
                            "description": desc,
                            "isMod": True
                        })
            
            elif source["name"] == "MODDED1":
                items = soup.select('article.post, .post-item, .game-card')[:num_results]
                for item in items:
                    title_el = item.select_one('h2 a, h3 a, .entry-title a, a.title')
                    if title_el:
                        title = title_el.get_text(strip=True)
                        link = title_el.get('href', '')
                        if link and not link.startswith('http'):
                            link = source["base_url"] + link
                        
                        img_el = item.select_one('img')
                        icon = img_el.get('data-src', '') or img_el.get('src', '') if img_el else ''
                        
                        if 'mod' in title.lower() or 'apk' in title.lower():
                            results.append({
                                "title": title,
                                "source": source["name"],
                                "url": link,
                                "icon": icon,
                                "description": "",
                                "isMod": True
                            })
            
            elif source["name"] == "HAPPYMOD":
                items = soup.select('.pdt-app-box, .app-item, .search-item')[:num_results]
                for item in items:
                    title_el = item.select_one('h3, .app-name, .title, a')
                    if title_el:
                        title = title_el.get_text(strip=True)
                        link_el = item.select_one('a[href]')
                        link = link_el.get('href', '') if link_el else ''
                        if link and not link.startswith('http'):
                            link = source["base_url"] + link
                        
                        img_el = item.select_one('img')
                        icon = img_el.get('data-src', '') or img_el.get('src', '') if img_el else ''
                        
                        results.append({
                            "title": title,
                            "source": source["name"],
                            "url": link,
                            "icon": icon,
                            "description": "",
                            "isMod": True
                        })
            
            if len(results) >= num_results:
                break
                
        except Exception as e:
            print(f"[ModSearch] Error searching {source['name']}: {e}", file=sys.stderr)
            continue
    
    return results[:num_results]

async def get_mod_download_link(page_url: str, source_name: str) -> Optional[Dict[str, Any]]:
    """Extract download link from mod page"""
    try:
        html = await fetch_with_protection(page_url, use_cloudscraper=True)
        if not html:
            return None
        
        soup = BeautifulSoup(html, 'html.parser')
        
        download_link = None
        file_info = {}
        
        download_buttons = soup.select('a[href*="download"], a.download-btn, .download-link a, a[class*="download"]')
        for btn in download_buttons:
            href = btn.get('href', '')
            if href and ('.apk' in href.lower() or 'download' in href.lower()):
                download_link = href
                break
        
        if not download_link:
            download_containers = soup.select('.download-box, .download-area, #download')
            for container in download_containers:
                link = container.select_one('a[href]')
                if link:
                    download_link = link.get('href')
                    break
        
        size_el = soup.select_one('.file-size, .size, [class*="size"]')
        if size_el:
            file_info['size'] = size_el.get_text(strip=True)
        
        version_el = soup.select_one('.version, [class*="version"]')
        if version_el:
            file_info['version'] = version_el.get_text(strip=True)
        
        return {
            "download_url": download_link,
            "source": source_name,
            "page_url": page_url,
            "file_info": file_info
        }
        
    except Exception as e:
        print(f"[ModDownload] Error: {e}", file=sys.stderr)
        return None

async def search_apkpure(query: str, num_results: int = 10) -> List[Dict[str, Any]]:
    """Search APKPure for apps matching the query using mobile site"""
    try:
        search_url = f"https://m.apkpure.com/search?q={quote_plus(query)}"
        
        print(f"[APKPure Search] Searching (mobile): {query}", file=sys.stderr)
        
        html_content = await fetch_with_protection(search_url)
        
        if not html_content:
            print(f"[APKPure Search] Failed to fetch search page", file=sys.stderr)
            return []
        
        soup = BeautifulSoup(html_content, 'lxml')
        apps = []
        seen_ids = set()
        
        def extract_app_id(href):
            if href.startswith('https://apkpure.com/'):
                href = href.replace('https://apkpure.com', '')
            elif href.startswith('https://m.apkpure.com/'):
                href = href.replace('https://m.apkpure.com', '')
            if not href.startswith('/'):
                return None
            parts = [p for p in href.strip('/').split('/') if p]
            if len(parts) >= 2:
                potential_id = parts[-1]
                if 'download' in potential_id.lower():
                    return None
                if '.' in potential_id and potential_id.count('.') >= 1:
                    return potential_id
            return None
        
        first_app = soup.find('div', class_='first')
        if first_app:
            link = first_app.find('a', href=True)
            if link:
                href = link.get('href', '')
                app_id = extract_app_id(href)
                if app_id and app_id not in seen_ids:
                    seen_ids.add(app_id)
                    p1 = first_app.find('p', class_='p1')
                    p2 = first_app.find('p', class_='p2')
                    app_name = p1.get_text(strip=True) if p1 else None
                    developer = p2.get_text(strip=True) if p2 else ''
                    
                    if not app_name:
                        parts = [p for p in href.strip('/').split('/') if p]
                        app_slug = parts[0] if parts else ''
                        app_name = app_slug.replace('-', ' ').title()
                    
                    img = first_app.find('img')
                    icon = img.get('src') or img.get('data-src') if img else None
                    
                    apps.append({
                        'title': app_name,
                        'appId': app_id,
                        'developer': developer,
                        'score': 0.0,
                        'icon': icon
                    })
                    print(f"[APKPure Search] Found (featured): {app_name} ({app_id})", file=sys.stderr)
        
        search_container = soup.find('ul', class_='search-res')
        
        if search_container:
            for li in search_container.find_all('li'):
                if len(apps) >= num_results:
                    break
                
                link = li.find('a', href=True)
                if not link:
                    continue
                
                href = link.get('href', '')
                app_id = extract_app_id(href)
                
                if not app_id or app_id in seen_ids:
                    continue
                seen_ids.add(app_id)
                
                p1 = li.find('p', class_='p1')
                p2 = li.find('p', class_='p2')
                
                app_name = p1.get_text(strip=True) if p1 else None
                developer = p2.get_text(strip=True) if p2 else ''
                
                if not app_name:
                    parts = [p for p in href.strip('/').split('/') if p]
                    app_slug = parts[0] if parts else ''
                    app_name = app_slug.replace('-', ' ').title()
                
                img = li.find('img')
                icon = None
                if img:
                    icon = img.get('src') or img.get('data-src') or img.get('data-original')
                
                score = 0.0
                score_elem = li.find(class_='star')
                if score_elem:
                    try:
                        score = float(score_elem.get_text(strip=True))
                    except:
                        pass
                
                apps.append({
                    'title': app_name,
                    'appId': app_id,
                    'developer': developer,
                    'score': score,
                    'icon': icon
                })
                print(f"[APKPure Search] Found: {app_name} ({app_id})", file=sys.stderr)
        
        print(f"[APKPure Search] Total found: {len(apps)} apps", file=sys.stderr)
        return apps[:num_results]
        
    except Exception as e:
        print(f"[APKPure Search] Error: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        return []

async def extract_content_with_trafilatura(url: str) -> Optional[str]:
    """Extract main content from a URL using trafilatura"""
    try:
        html = await fetch_with_protection(url, use_cloudscraper=True)
        if html:
            extracted = trafilatura.extract(html)
            return extracted
    except Exception as e:
        print(f"[Trafilatura] Error: {e}", file=sys.stderr)
    return None

file_cache: Dict[str, Dict[str, Any]] = {}
download_locks: Dict[str, asyncio.Lock] = {}
pending_deletions: Dict[str, asyncio.Task] = {}

stats = {
    "total_requests": 0,
    "downloads": 0,
    "not_found": 0,
    "cache_hits": 0
}

def get_download_lock(package_name: str) -> asyncio.Lock:
    if package_name not in download_locks:
        download_locks[package_name] = asyncio.Lock()
    return download_locks[package_name]

async def schedule_file_deletion(file_path: str, delay: int = 60):
    await asyncio.sleep(delay)
    try:
        if os.path.exists(file_path):
            os.remove(file_path)
            print(f"[Cleanup] Deleted: {os.path.basename(file_path)}", file=sys.stderr)
    except Exception as e:
        print(f"[Cleanup Error] {file_path}: {e}", file=sys.stderr)

async def cleanup_old_files_async():
    """Async version of cleanup using aiofiles"""
    try:
        now = time.time()
        max_age = 300
        for filename in os.listdir(DOWNLOADS_DIR):
            file_path = os.path.join(DOWNLOADS_DIR, filename)
            if os.path.isfile(file_path):
                file_age = now - os.path.getmtime(file_path)
                if file_age > max_age:
                    try:
                        os.remove(file_path)
                        print(f"[Cleanup] Removed old file: {filename}", file=sys.stderr)
                    except Exception as e:
                        print(f"[Cleanup] Failed to remove {filename}: {e}", file=sys.stderr)
    except Exception as e:
        print(f"[Cleanup Error] {e}", file=sys.stderr)

async def periodic_cleanup():
    while True:
        await asyncio.sleep(60)
        await cleanup_old_files_async()

@asynccontextmanager
async def lifespan(app: FastAPI):
    global httpx_client
    print("[Server] Starting with enhanced protection (cloudscraper, curl-cffi, httpx)...", file=sys.stderr)
    httpx_client = httpx.AsyncClient(
        timeout=30.0,
        follow_redirects=True,
        headers={
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        }
    )
    asyncio.create_task(periodic_cleanup())
    yield
    if httpx_client:
        await httpx_client.aclose()
    print("[Server] Shutting down...", file=sys.stderr)

app = FastAPI(title="APK Download API (Enhanced)", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def download_with_apkeep(package_name: str, output_dir: str) -> Optional[str]:
    try:
        print(f"[apkeep] Downloading {package_name}...", file=sys.stderr)
        start_time = time.time()
        
        result = subprocess.run(
            [APKEEP_PATH, "-a", package_name, output_dir],
            capture_output=True,
            text=True,
            timeout=300
        )
        
        elapsed = time.time() - start_time
        
        if "downloaded successfully" in result.stdout.lower():
            for ext in ['.xapk', '.apk', '.apks']:
                file_path = os.path.join(output_dir, f"{package_name}{ext}")
                if os.path.exists(file_path):
                    size_mb = os.path.getsize(file_path) / (1024 * 1024)
                    print(f"[apkeep] Downloaded {package_name}: {size_mb:.1f} MB in {elapsed:.1f}s", file=sys.stderr)
                    return file_path
        
        if "could not get download url" in result.stdout.lower() or "skipping" in result.stdout.lower():
            print(f"[apkeep] App not found: {package_name}", file=sys.stderr)
            return None
            
        print(f"[apkeep] Failed: {result.stdout} {result.stderr}", file=sys.stderr)
        return None
        
    except subprocess.TimeoutExpired:
        print(f"[apkeep] Timeout for {package_name}", file=sys.stderr)
        return None
    except Exception as e:
        print(f"[apkeep] Error: {e}", file=sys.stderr)
        return None

@app.get("/")
async def root():
    return {
        "status": "running",
        "engine": "apkeep + aria2 + cloudscraper + curl-cffi + httpx",
        "features": [
            "CloudScraper bypass",
            "curl-cffi impersonation",
            "httpx async client",
            "aria2 multi-connection download",
            "lxml fast parsing",
            "trafilatura content extraction"
        ],
        "stats": stats
    }

@app.head("/download/{package_name}")
async def head_download_apk(package_name: str):
    """Return file size without downloading - for size check before download"""
    for ext in ['.xapk', '.apk', '.apks']:
        cached_path = os.path.join(DOWNLOADS_DIR, f"{package_name}{ext}")
        if os.path.exists(cached_path):
            file_size = os.path.getsize(cached_path)
            if file_size > 100000:
                return Response(
                    content=b"",
                    headers={
                        "Content-Length": str(file_size),
                        "X-File-Type": ext[1:],
                        "X-Cached": "true"
                    }
                )
    return Response(content=b"", headers={"Content-Length": "0", "X-Cached": "false"})

@app.get("/download/{package_name}")
async def download_apk(package_name: str, background_tasks: BackgroundTasks, force_apkeep: bool = False, request: Request = None):
    stats["total_requests"] += 1
    now = time.time()
    
    force_apkeep_header = False
    if request and request.headers.get("X-Force-Apkeep") == "true":
        force_apkeep_header = True
    
    use_apkeep_only = force_apkeep or force_apkeep_header
    
    if package_name in not_found_cache:
        if now - not_found_cache[package_name] < NOT_FOUND_CACHE_TTL:
            print(f"[Cache] {package_name} is cached as not found", file=sys.stderr)
            stats["cache_hits"] += 1
            raise HTTPException(status_code=404, detail=f"App {package_name} not found (cached)")
        else:
            del not_found_cache[package_name]
    
    lock = get_download_lock(package_name)
    
    async with lock:
        if not use_apkeep_only:
            for ext in ['.xapk', '.apk', '.apks']:
                cached_path = os.path.join(DOWNLOADS_DIR, f"{package_name}{ext}")
                if os.path.exists(cached_path):
                    file_size = os.path.getsize(cached_path)
                    if file_size > 100000:
                        print(f"[Cache] Serving cached file: {package_name}", file=sys.stderr)
                        stats["cache_hits"] += 1
                        file_type = ext[1:]
                        return FileResponse(
                            path=cached_path,
                            filename=f"{package_name}{ext}",
                            media_type="application/octet-stream",
                            headers={
                                "X-Source": "cache",
                                "X-File-Type": file_type,
                                "X-File-Size": str(file_size),
                                "Cache-Control": "no-cache"
                            }
                        )
        
        file_path = None
        source = None
        
        if use_apkeep_only:
            print(f"[Download] Force using apkeep for {package_name}...", file=sys.stderr)
            loop = asyncio.get_event_loop()
            file_path = await loop.run_in_executor(
                None,
                download_with_apkeep,
                package_name,
                DOWNLOADS_DIR
            )
            if file_path:
                source = "apkeep"
        else:
            print(f"[Download] Trying APKPure+aria2 for {package_name}...", file=sys.stderr)
            file_path = await download_from_apkpure(package_name, DOWNLOADS_DIR)
            if file_path:
                source = "aria2+apkpure"
            
            if not file_path:
                print(f"[Download] Falling back to apkeep for {package_name}...", file=sys.stderr)
                loop = asyncio.get_event_loop()
                file_path = await loop.run_in_executor(
                    None,
                    download_with_apkeep,
                    package_name,
                    DOWNLOADS_DIR
                )
                if file_path:
                    source = "apkeep"
        
        if not file_path or not os.path.exists(file_path):
            not_found_cache[package_name] = time.time()
            stats["not_found"] += 1
            print(f"[Not Found] {package_name} added to cache for 1 hour", file=sys.stderr)
            raise HTTPException(status_code=404, detail=f"App {package_name} not found")
        
        file_size = os.path.getsize(file_path)
        file_type = os.path.splitext(file_path)[1][1:]
        stats["downloads"] += 1
        
        deletion_task = asyncio.create_task(schedule_file_deletion(file_path, 60))
        pending_deletions[package_name] = deletion_task
        
        print(f"[Success] {package_name} downloaded via {source}: {file_size/(1024*1024):.1f} MB", file=sys.stderr)
        
        return FileResponse(
            path=file_path,
            filename=os.path.basename(file_path),
            media_type="application/octet-stream",
            headers={
                "X-Source": source,
                "X-File-Type": file_type,
                "X-File-Size": str(file_size),
                "Cache-Control": "no-cache"
            }
        )

@app.get("/info/{package_name}")
async def get_info(package_name: str):
    if package_name in not_found_cache:
        now = time.time()
        if now - not_found_cache[package_name] < NOT_FOUND_CACHE_TTL:
            raise HTTPException(status_code=404, detail=f"App {package_name} not found (cached)")
    
    return {
        "package_name": package_name,
        "source": "apkeep",
        "status": "available"
    }

@app.get("/not-found-cache")
async def get_not_found_cache():
    now = time.time()
    result = {}
    for pkg, timestamp in not_found_cache.items():
        remaining = NOT_FOUND_CACHE_TTL - (now - timestamp)
        if remaining > 0:
            result[pkg] = {
                "cached_at": datetime.fromtimestamp(timestamp).isoformat(),
                "expires_in_minutes": round(remaining / 60, 1)
            }
    return {"not_found_apps": result, "count": len(result)}

@app.delete("/not-found-cache/{package_name}")
async def remove_from_not_found_cache(package_name: str):
    if package_name in not_found_cache:
        del not_found_cache[package_name]
        return {"status": "removed", "package": package_name}
    return {"status": "not_in_cache", "package": package_name}

@app.delete("/cache")
async def clear_cache():
    global not_found_cache, file_cache
    
    for task in pending_deletions.values():
        task.cancel()
    pending_deletions.clear()
    
    for filename in os.listdir(DOWNLOADS_DIR):
        try:
            os.remove(os.path.join(DOWNLOADS_DIR, filename))
        except:
            pass
    
    not_found_cache = {}
    file_cache = {}
    
    return {"status": "cache_cleared"}

@app.get("/stats")
async def get_stats():
    return {
        "stats": stats,
        "cached_not_found": len(not_found_cache),
        "downloads_dir_size": sum(
            os.path.getsize(os.path.join(DOWNLOADS_DIR, f))
            for f in os.listdir(DOWNLOADS_DIR)
            if os.path.isfile(os.path.join(DOWNLOADS_DIR, f))
        ) / (1024 * 1024)
    }

@app.get("/search")
async def search_apps(q: str, num: int = 10, combined: bool = True):
    """Search APKPure for apps"""
    if not q or len(q.strip()) == 0:
        raise HTTPException(status_code=400, detail="Search query is required")
    
    query = q.strip()
    
    results = await search_apkpure(query, min(num, 20))
    
    for app in results:
        app["isMod"] = False
        app["source"] = "APKPure"
    
    return {
        "query": query,
        "count": len(results),
        "normal_count": len(results),
        "mod_count": 0,
        "results": results
    }

@app.get("/search-normal")
async def search_normal_apps(q: str, num: int = 10):
    """Search for normal apps on APKPure only"""
    if not q or len(q.strip()) == 0:
        raise HTTPException(status_code=400, detail="Search query is required")
    
    results = await search_apkpure(q.strip(), min(num, 20))
    
    return {
        "query": q,
        "count": len(results),
        "results": results
    }

@app.get("/app/{package_name}")
async def get_app_details(package_name: str):
    """Get app details by package name - search if exact match"""
    results = await search_apkpure(package_name, 1)
    
    if not results:
        raise HTTPException(status_code=404, detail=f"App {package_name} not found")
    
    exact_match = None
    for app in results:
        if app.get('appId') == package_name:
            exact_match = app
            break
    
    if exact_match:
        return exact_match
    
    return results[0] if results else None

@app.get("/extract")
async def extract_url_content(url: str):
    """Extract main content from a URL using trafilatura"""
    if not url:
        raise HTTPException(status_code=400, detail="URL is required")
    
    content = await extract_content_with_trafilatura(url)
    
    if not content:
        raise HTTPException(status_code=404, detail="Could not extract content from URL")
    
    return {
        "url": url,
        "content": content
    }

@app.get("/search-mod")
async def search_mod_apps(q: str, num: int = 10, source: str = "all"):
    """Search for modded APKs from GetModsAPK + AN1 (مهكرة)"""
    if not q or len(q.strip()) == 0:
        raise HTTPException(status_code=400, detail="Search query is required")
    
    query = q.strip()
    
    getmodsapk_task = asyncio.create_task(search_getmodsapk(query, num))
    an1_task = asyncio.create_task(search_an1(query, num))
    
    getmodsapk_results, an1_results = await asyncio.gather(getmodsapk_task, an1_task)
    
    all_results = getmodsapk_results + an1_results
    
    return {
        "query": q,
        "count": len(all_results),
        "results": all_results[:num*2],
        "sources": ["GetModsAPK", "AN1"],
        "warning": "⚠️ Modded APKs may contain security risks. Download at your own risk."
    }

@app.get("/search-modyolo")
async def search_modyolo_apps(q: str, num: int = 10):
    """Search for modded APKs from MODYOLO (مهكرة)"""
    if not q or len(q.strip()) == 0:
        raise HTTPException(status_code=400, detail="Search query is required")
    
    results = await search_modyolo(q.strip(), min(num, 20))
    
    return {
        "query": q,
        "count": len(results),
        "results": results,
        "source": "MODYOLO",
        "warning": "⚠️ Modded APKs may contain security risks. Download at your own risk."
    }

@app.get("/modyolo-download")
async def get_modyolo_download(url: str):
    """Get download link from MODYOLO page URL"""
    if not url:
        raise HTTPException(status_code=400, detail="URL is required")
    
    download_info = await get_modyolo_download_link(url)
    
    if not download_info or not download_info.get("download_url"):
        raise HTTPException(status_code=404, detail="Could not find download link")
    
    return {
        **download_info,
        "warning": "⚠️ Modded APKs may contain security risks."
    }

@app.get("/search-an1")
async def search_an1_apps(q: str, num: int = 10):
    """Search for modded APKs from AN1.com (مهكرة)"""
    if not q or len(q.strip()) == 0:
        raise HTTPException(status_code=400, detail="Search query is required")
    
    results = await search_an1(q.strip(), min(num, 20))
    
    return {
        "query": q,
        "count": len(results),
        "results": results,
        "source": "AN1",
        "warning": "⚠️ Modded APKs may contain security risks. Download at your own risk."
    }

@app.get("/an1-download")
async def get_an1_download(url: str):
    """Get direct download link from AN1.com page URL"""
    if not url:
        raise HTTPException(status_code=400, detail="URL is required")
    
    download_info = await get_an1_download_link(url)
    
    if not download_info or not download_info.get("download_url"):
        raise HTTPException(status_code=404, detail="Could not find download link")
    
    return {
        **download_info,
        "warning": "⚠️ Modded APKs may contain security risks."
    }

@app.get("/search-apkmb")
async def search_apkmb_apps(q: str, num: int = 10):
    """Search for modded APKs from GetModsAPK (replaces APKMB)"""
    if not q or len(q.strip()) == 0:
        raise HTTPException(status_code=400, detail="Search query is required")
    
    results = await search_getmodsapk(q.strip(), min(num, 20))
    
    return {
        "query": q,
        "count": len(results),
        "results": results,
        "source": "GetModsAPK",
        "warning": "⚠️ Modded APKs may contain security risks. Download at your own risk."
    }

@app.get("/apkmb-download")
async def get_apkmb_download(url: str):
    """Get download link from GetModsAPK page URL (replaces APKMB)"""
    if not url:
        raise HTTPException(status_code=400, detail="URL is required")
    
    download_info = await get_getmodsapk_download_link(url)
    
    if not download_info or not download_info.get("download_url"):
        raise HTTPException(status_code=404, detail="Could not find download link")
    
    return {
        **download_info,
        "warning": "⚠️ Modded APKs may contain security risks."
    }

@app.get("/mod-download-info")
async def get_mod_download_info(url: str, source: str = ""):
    """Get download information from a mod page"""
    if not url:
        raise HTTPException(status_code=400, detail="URL is required")
    
    info = await get_mod_download_link(url, source)
    
    if not info or not info.get("download_url"):
        raise HTTPException(status_code=404, detail="Could not find download link")
    
    return {
        **info,
        "warning": "⚠️ Modded APKs may contain malware. Install at your own risk."
    }

@app.get("/search-traidsoft")
async def search_traidsoft_apps(q: str, num: int = 10):
    """Search TraidSoft.net for modded apps (مهكرة)"""
    if not q or len(q.strip()) == 0:
        raise HTTPException(status_code=400, detail="Search query is required")
    
    results = await search_traidsoft(q.strip(), min(num, 20))
    
    return {
        "query": q,
        "count": len(results),
        "results": results,
        "source": "TraidSoft",
        "warning": "⚠️ Modded APKs may contain security risks. Download at your own risk."
    }

@app.get("/traidsoft-download")
async def get_traidsoft_download(url: str):
    """Get download links from TraidSoft page URL"""
    if not url:
        raise HTTPException(status_code=400, detail="URL is required")
    
    download_info = await get_traidsoft_download_link(url)
    
    if not download_info:
        raise HTTPException(status_code=404, detail="Could not find download links")
    
    return {
        **download_info,
        "warning": "⚠️ Modded APKs may contain malware. Install at your own risk."
    }

@app.get("/search-gamessapk")
async def search_gamessapk_apps(q: str, num: int = 10):
    """Search GamesAPK.com for games (Arabic games site)"""
    if not q or len(q.strip()) == 0:
        raise HTTPException(status_code=400, detail="Search query is required")
    
    results = await search_gamessapk(q.strip(), min(num, 20))
    
    return {
        "query": q,
        "count": len(results),
        "results": results,
        "source": "GamesAPK"
    }

@app.get("/gamessapk-download")
async def get_gamessapk_download(url: str):
    """Get download links from GamesAPK.com page URL"""
    if not url:
        raise HTTPException(status_code=400, detail="URL is required")
    
    download_info = await get_gamessapk_download_link(url)
    
    if not download_info:
        raise HTTPException(status_code=404, detail="Could not find download links")
    
    return download_info

@app.get("/mega-download")
async def get_mega_download(url: str):
    """Get direct download link from MEGA.nz URL"""
    if not url or 'mega' not in url.lower():
        raise HTTPException(status_code=400, detail="Valid MEGA.nz URL is required")
    
    download_info = await get_mega_download_info(url)
    
    if not download_info:
        raise HTTPException(status_code=404, detail="Could not get MEGA download info")
    
    return download_info

async def get_mediafire_direct_link(mediafire_url: str) -> Optional[Dict[str, Any]]:
    """Extract direct download link from MediaFire page"""
    try:
        print(f"[MediaFire] Getting direct link from: {mediafire_url}", file=sys.stderr)
        
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
        }
        
        loop = asyncio.get_event_loop()
        response = await loop.run_in_executor(
            None,
            lambda: requests.get(mediafire_url, headers=headers, timeout=30)
        )
        
        if response.status_code != 200:
            print(f"[MediaFire] Failed with status {response.status_code}", file=sys.stderr)
            return None
        
        html = response.text
        
        # Method 1: Look for direct download link in aria-label or download button
        download_match = re.search(r'href="(https://download\d*\.mediafire\.com/[^"]+)"', html)
        if download_match:
            direct_url = download_match.group(1)
            print(f"[MediaFire] Found direct link: {direct_url[:80]}...", file=sys.stderr)
            
            # Extract filename and size from page
            filename_match = re.search(r'<div class="filename">([^<]+)</div>', html)
            filename = filename_match.group(1).strip() if filename_match else ''
            
            size_match = re.search(r'<span class="details">.*?(\d+(?:\.\d+)?\s*(?:KB|MB|GB)).*?</span>', html, re.DOTALL)
            size = size_match.group(1) if size_match else ''
            
            return {
                "download_url": direct_url,
                "filename": filename,
                "size": size,
                "source": "MediaFire",
                "original_url": mediafire_url
            }
        
        # Method 2: Look for download button with data-href or onclick
        button_match = re.search(r'id="downloadButton"[^>]*href="([^"]+)"', html)
        if button_match:
            direct_url = button_match.group(1)
            print(f"[MediaFire] Found button link: {direct_url[:80]}...", file=sys.stderr)
            return {
                "download_url": direct_url,
                "source": "MediaFire",
                "original_url": mediafire_url
            }
        
        # Method 3: Look for aria-label download
        aria_match = re.search(r'aria-label="Download file"[^>]*href="([^"]+)"', html)
        if aria_match:
            direct_url = aria_match.group(1)
            print(f"[MediaFire] Found aria link: {direct_url[:80]}...", file=sys.stderr)
            return {
                "download_url": direct_url,
                "source": "MediaFire",
                "original_url": mediafire_url
            }
        
        print(f"[MediaFire] No direct download link found", file=sys.stderr)
        return None
        
    except Exception as e:
        print(f"[MediaFire] Error: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        return None

@app.get("/mediafire-download")
async def get_mediafire_download(url: str):
    """Get direct download link from MediaFire URL"""
    if not url or 'mediafire' not in url.lower():
        raise HTTPException(status_code=400, detail="Valid MediaFire URL is required")
    
    download_info = await get_mediafire_direct_link(url)
    
    if not download_info:
        raise HTTPException(status_code=404, detail="Could not get MediaFire download link")
    
    return download_info

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
