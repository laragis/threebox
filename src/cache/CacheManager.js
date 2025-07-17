/**
 * CacheManager - Persistent cache storage for Threebox objects
 * Uses CacheStorage API for storing cached 3D models and other resources
 * @author jscastro / https://github.com/jscastro76
 */

class CacheManager {
    constructor(options = {}) {
        this.cacheName = options.cacheName || 'threebox-cache';
        this.maxCacheAge = options.maxAge || 7 * 24 * 60 * 60 * 1000; // 7 days default
        this.maxCacheEntries = options.maxCacheEntries || 100; // Max number of cached items
        this.cacheAvailable = this.checkCacheAvailability();
        this.memoryCache = new Map(); // In-memory cache for quick access
        this.initPromise = this.init();
    }

    /**
     * Check if CacheStorage is available
     */
    checkCacheAvailability() {
        try {
            if (typeof window === 'undefined' || !window.caches) {
                return false;
            }
            // CacheStorage requires HTTPS or localhost
            return location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
        } catch (e) {
            return false;
        }
    }

    /**
     * Initialize cache and cleanup expired entries
     */
    async init() {
        if (!this.cacheAvailable) {
            console.warn('CacheStorage not available (requires HTTPS), falling back to memory cache only');
            return;
        }

        try {
            // Cleanup expired entries and old cache versions on initialization
            await this.cleanupExpiredEntries();
            await this.cleanupOldCaches();
        } catch (error) {
            console.warn('Error during cache initialization:', error);
        }
    }

    /**
     * Generate a cache key from options
     */
    generateKey(url, options = {}) {
        // Create a hash-like key from URL and relevant options
        const keyData = {
            url: url,
            type: options.type || 'model',
            scale: options.scale,
            units: options.units
        };
        return btoa(JSON.stringify(keyData)).replace(/[^a-zA-Z0-9]/g, '');
    }

    /**
     * Create a Request object for caching (supports both URLs and keys)
     */
    createCacheRequest(urlOrKey) {
        // If it's already a URL, use it directly (like Mapbox does)
        if (urlOrKey.startsWith('http://') || urlOrKey.startsWith('https://')) {
            return new Request(urlOrKey, {
                method: 'GET',
                mode: 'cors',
                cache: 'default'
            });
        }
        
        // Otherwise, use our custom scheme for generated keys
        const url = `https://threebox-cache.local/${urlOrKey}`;
        return new Request(url, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });
    }

    /**
     * Create a Response object for caching (handles both file content and data)
     */
    createCacheResponse(data, metadata = {}, contentType = 'application/json') {
        let responseBody;
        let headers = {
            'Cache-Control': `max-age=${Math.floor(this.maxCacheAge / 1000)}`,
            'X-Threebox-Timestamp': Date.now().toString(),
            'X-Threebox-Metadata': JSON.stringify(metadata)
        };

        // Handle different data types like Mapbox does
        if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
            // Binary data (like .glb files, textures)
            responseBody = data;
            headers['Content-Type'] = contentType || 'application/octet-stream';
        } else if (typeof data === 'string' && contentType !== 'application/json') {
            // Text data (like .obj files, .mtl files)
            responseBody = data;
            headers['Content-Type'] = contentType || 'text/plain';
        } else {
            // JSON data (our custom objects)
            const responseData = {
                data: data,
                timestamp: Date.now(),
                metadata: metadata
            };
            responseBody = JSON.stringify(responseData);
            headers['Content-Type'] = 'application/json';
        }
        
        return new Response(responseBody, {
            status: 200,
            statusText: 'OK',
            headers: headers
        });
    }

    /**
     * Cache a file from URL (like Mapbox caches map tiles and resources)
     */
    async cacheFileFromUrl(url, options = {}) {
        if (!this.cacheAvailable) {
            console.warn('CacheStorage not available, cannot cache file from URL');
            return null;
        }

        try {
            await this.initPromise;
            const cache = await caches.open(this.cacheName);
            
            // Check if already cached
            const cachedResponse = await cache.match(url);
            if (cachedResponse && this.isResponseValid(cachedResponse)) {
                return cachedResponse;
            }

            // Fetch the file
            const response = await fetch(url, {
                mode: 'cors',
                cache: 'default',
                ...options
            });

            if (!response.ok) {
                throw new Error(`Failed to fetch ${url}: ${response.status}`);
            }

            // Clone the response before caching (responses can only be read once)
            const responseToCache = response.clone();
            
            // Add our custom headers for cache management
            const enhancedResponse = new Response(await responseToCache.arrayBuffer(), {
                status: response.status,
                statusText: response.statusText,
                headers: {
                    ...Object.fromEntries(response.headers.entries()),
                    'X-Threebox-Timestamp': Date.now().toString(),
                    'X-Threebox-Cached': 'true'
                }
            });

            // Cache the enhanced response
            await cache.put(url, enhancedResponse);
            
            // Check cache size after adding
            await this.checkCacheSize();
            
            return response;
        } catch (error) {
            console.warn('Failed to cache file from URL:', error);
            return null;
        }
    }

    /**
     * Get item from cache (supports both keys and URLs)
     */
    async get(keyOrUrl) {
        // If it's a URL, try to get it directly from cache
        if (keyOrUrl.startsWith('http://') || keyOrUrl.startsWith('https://')) {
            return await this.getFromUrl(keyOrUrl);
        }

        // Otherwise, handle as a generated key
        // First check memory cache
        if (this.memoryCache.has(keyOrUrl)) {
            const item = this.memoryCache.get(keyOrUrl);
            if (this.isValid(item)) {
                return item.data;
            } else {
                this.memoryCache.delete(keyOrUrl);
            }
        }

        // Then check CacheStorage
        if (!this.cacheAvailable) return null;

        try {
            await this.initPromise;
            const cache = await caches.open(this.cacheName);
            const request = this.createCacheRequest(keyOrUrl);
            const cachedResponse = await cache.match(request);

            if (cachedResponse) {
                const contentType = cachedResponse.headers.get('Content-Type');
                
                if (contentType === 'application/json') {
                    const responseData = await cachedResponse.json();
                    if (this.isValid(responseData)) {
                        // Add to memory cache for faster future access
                        this.memoryCache.set(keyOrUrl, responseData);
                        return responseData.data;
                    } else {
                        // Remove expired entry
                        await this.delete(keyOrUrl);
                        return null;
                    }
                } else {
                    // Handle binary/text data
                    if (this.isResponseValid(cachedResponse)) {
                        return cachedResponse;
                    } else {
                        await this.delete(keyOrUrl);
                        return null;
                    }
                }
            }
            return null;
        } catch (error) {
            console.warn('Failed to read from CacheStorage:', error);
            return null;
        }
    }

    /**
     * Get cached response from URL (like Mapbox does)
     */
    async getFromUrl(url) {
        if (!this.cacheAvailable) return null;

        try {
            await this.initPromise;
            const cache = await caches.open(this.cacheName);
            const cachedResponse = await cache.match(url);

            if (cachedResponse && this.isResponseValid(cachedResponse)) {
                return cachedResponse;
            }
            return null;
        } catch (error) {
            console.warn('Failed to get cached URL:', error);
            return null;
        }
    }

    /**
     * Set item in cache (supports both keys and URLs with different data types)
     */
    async set(keyOrUrl, data, metadata = {}, contentType = null) {
        // If it's a URL, we should use cacheFileFromUrl instead
        if (keyOrUrl.startsWith('http://') || keyOrUrl.startsWith('https://')) {
            console.warn('Use cacheFileFromUrl() for URLs instead of set()');
            return false;
        }

        const item = {
            data: data,
            timestamp: Date.now(),
            metadata: metadata
        };

        // Add to memory cache
        this.memoryCache.set(keyOrUrl, item);

        // Add to CacheStorage
        if (!this.cacheAvailable) return false;

        try {
            await this.initPromise;
            const cache = await caches.open(this.cacheName);
            const request = this.createCacheRequest(keyOrUrl);
            const response = this.createCacheResponse(data, metadata, contentType);
            
            await cache.put(request, response);
            
            // Check if we need to cleanup old entries
            await this.checkCacheSize();
            return true;
        } catch (error) {
            console.warn('Failed to write to CacheStorage:', error);
            return false;
        }
    }

    /**
     * Delete item from cache (supports both keys and URLs)
     */
    async delete(keyOrUrl) {
        // Remove from memory cache (only for keys, not URLs)
        if (!keyOrUrl.startsWith('http://') && !keyOrUrl.startsWith('https://')) {
            this.memoryCache.delete(keyOrUrl);
        }

        // Remove from CacheStorage
        if (!this.cacheAvailable) return true;

        try {
            const cache = await caches.open(this.cacheName);
            const request = this.createCacheRequest(keyOrUrl);
            return await cache.delete(request);
        } catch (error) {
            console.warn('Failed to delete from CacheStorage:', error);
            return false;
        }
    }

    /**
     * Clear all cache
     */
    async clear() {
        // Clear memory cache
        this.memoryCache.clear();

        // Clear CacheStorage
        if (!this.cacheAvailable) return true;

        try {
            return await caches.delete(this.cacheName);
        } catch (error) {
            console.warn('Failed to clear CacheStorage:', error);
            return false;
        }
    }

    /**
     * Check if cache item is still valid
     */
    isValid(item) {
        if (!item || !item.timestamp) return false;
        return (Date.now() - item.timestamp) < this.maxCacheAge;
    }

    /**
     * Check if cached response is still valid (for URL-based caches)
     */
    isResponseValid(response) {
        const timestamp = response.headers.get('X-Threebox-Timestamp');
        if (!timestamp) return false;
        return (Date.now() - parseInt(timestamp)) < this.maxCacheAge;
    }

    /**
     * Check cache size and cleanup if necessary
     */
    async checkCacheSize() {
        if (!this.cacheAvailable) return;

        try {
            const cache = await caches.open(this.cacheName);
            const requests = await cache.keys();
            
            if (requests.length > this.maxCacheEntries) {
                // Get all cached responses with timestamps
                const cacheEntries = await Promise.all(
                    requests.map(async (request) => {
                        const response = await cache.match(request);
                        const timestamp = response.headers.get('X-Threebox-Timestamp');
                        return {
                            request,
                            timestamp: parseInt(timestamp) || 0
                        };
                    })
                );

                // Sort by timestamp (oldest first) and remove oldest entries
                cacheEntries.sort((a, b) => a.timestamp - b.timestamp);
                const entriesToRemove = cacheEntries.slice(0, cacheEntries.length - this.maxCacheEntries + 10); // Remove 10 extra

                for (const entry of entriesToRemove) {
                    await cache.delete(entry.request);
                    // Also remove from memory cache if present (only for non-URL keys)
                    const url = new URL(entry.request.url);
                    if (url.hostname === 'threebox-cache.local') {
                        const key = url.pathname.substring(1); // Remove leading slash
                        this.memoryCache.delete(key);
                    }
                }
            }
        } catch (error) {
            console.warn('Error checking cache size:', error);
        }
    }

    /**
     * Cleanup expired entries
     */
    async cleanupExpiredEntries() {
        if (!this.cacheAvailable) return;

        try {
            const cache = await caches.open(this.cacheName);
            const requests = await cache.keys();
            const cutoffTime = Date.now() - this.maxCacheAge;

            for (const request of requests) {
                const response = await cache.match(request);
                const timestamp = parseInt(response.headers.get('X-Threebox-Timestamp')) || 0;
                
                if (timestamp < cutoffTime) {
                    await cache.delete(request);
                    // Also remove from memory cache if present (only for non-URL keys)
                    const url = new URL(request.url);
                    if (url.hostname === 'threebox-cache.local') {
                        const key = url.pathname.substring(1); // Remove leading slash
                        this.memoryCache.delete(key);
                    }
                }
            }
        } catch (error) {
            console.warn('Error during expired entries cleanup:', error);
        }
    }

    /**
     * Cleanup old cache versions
     */
    async cleanupOldCaches() {
        if (!this.cacheAvailable) return;

        try {
            const cacheNames = await caches.keys();
            const currentCacheName = this.cacheName;

            for (const cacheName of cacheNames) {
                // Delete old threebox cache versions
                if (cacheName.startsWith('threebox-cache-') && cacheName !== currentCacheName) {
                    await caches.delete(cacheName);
                }
            }
        } catch (error) {
            console.warn('Error during old cache cleanup:', error);
        }
    }

    /**
     * Load a file with caching (like Mapbox does for tiles and resources)
     * This method first checks cache, then fetches if not found
     */
    async loadFile(url, options = {}) {
        try {
            // First try to get from cache
            const cachedResponse = await this.getFromUrl(url);
            if (cachedResponse) {
                console.log(`Cache HIT for: ${url}`);
                return cachedResponse;
            }

            console.log(`Cache MISS for: ${url}`);
            
            // If not in cache, fetch and cache it
            const response = await this.cacheFileFromUrl(url, options);
            return response;
        } catch (error) {
            console.error('Failed to load file:', error);
            throw error;
        }
    }

    /**
     * Get cache statistics
     */
    async getStats() {
        const stats = {
            memoryItems: this.memoryCache.size,
            persistentItems: 0,
            totalSize: 0,
            maxEntries: this.maxCacheEntries,
            cacheAvailable: this.cacheAvailable,
            cacheName: this.cacheName
        };

        if (!this.cacheAvailable) {
            return stats;
        }

        try {
            const cache = await caches.open(this.cacheName);
            const requests = await cache.keys();
            stats.persistentItems = requests.length;

            // Estimate total size by checking a few responses
            let estimatedSize = 0;
            const sampleSize = Math.min(requests.length, 5);
            
            for (let i = 0; i < sampleSize; i++) {
                const response = await cache.match(requests[i]);
                const text = await response.clone().text();
                estimatedSize += text.length;
            }

            // Extrapolate total size
            if (sampleSize > 0) {
                stats.totalSize = Math.round((estimatedSize / sampleSize) * requests.length);
            }

            return stats;
        } catch (error) {
            return {
                ...stats,
                error: 'Failed to read cache stats: ' + error.message
            };
        }
    }
}

module.exports = CacheManager;
