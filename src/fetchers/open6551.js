const BASE_URL = 'https://ai.6551.io';

function getAuthHeaders() {
    const token = process.env.TWITTER_TOKEN || process.env.OPENNEWS_TOKEN || '';
    return {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
    };
}

/**
 * Fetch Twitter/X user profile information via 6551 OpenTwitter API
 * @param {string} username - Twitter handle (without @)
 */
export async function getTwitterUserInfo(username) {
    if (!username) return null;
    const cleanUsername = username.replace(/^@/, '').trim();
    try {
        const res = await fetch(`${BASE_URL}/open/twitter_user_info`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ username: cleanUsername }),
            signal: AbortSignal.timeout(10000)
        });
        const data = await res.json();
        return data?.data || data || null;
    } catch (err) {
        console.warn(`[6551 OpenTwitter] Error fetching user info for @${cleanUsername}: ${err.message}`);
        return null;
    }
}

/**
 * Fetch latest tweets for a Twitter user via 6551 OpenTwitter API
 * @param {string} username
 * @param {number} maxResults
 */
export async function getTwitterUserTweets(username, maxResults = 10) {
    if (!username) return [];
    const cleanUsername = username.replace(/^@/, '').trim();
    try {
        const res = await fetch(`${BASE_URL}/open/twitter_user_tweets`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({
                username: cleanUsername,
                maxResults,
                product: 'Latest',
                includeReplies: false,
                includeRetweets: false
            }),
            signal: AbortSignal.timeout(10000)
        });
        const data = await res.json();
        return data?.data || data || [];
    } catch (err) {
        console.warn(`[6551 OpenTwitter] Error fetching tweets for @${cleanUsername}: ${err.message}`);
        return [];
    }
}

/**
 * Search Twitter for keywords or token address via 6551 OpenTwitter API
 * @param {string} query
 * @param {number} maxResults
 */
export async function searchTwitter(query, maxResults = 10) {
    if (!query) return [];
    try {
        const res = await fetch(`${BASE_URL}/open/search_twitter`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({
                query,
                maxResults,
                product: 'Latest'
            }),
            signal: AbortSignal.timeout(10000)
        });
        const data = await res.json();
        return data?.data || data || [];
    } catch (err) {
        console.warn(`[6551 OpenTwitter] Search error for "${query}": ${err.message}`);
        return [];
    }
}

/**
 * Fetch breaking/hot crypto & Web3 news via 6551 OpenNews API
 * @param {string} category - Defaults to 'web3'
 */
export async function getHotCryptoNews(category = 'web3') {
    try {
        const res = await fetch(`${BASE_URL}/open/free_hot?category=${category}`, {
            headers: getAuthHeaders(),
            signal: AbortSignal.timeout(10000)
        });
        const data = await res.json();
        if (data?.success && data?.news?.items) {
            return data.news.items;
        }
        return data?.data || [];
    } catch (err) {
        console.warn(`[6551 OpenNews] Error fetching hot news: ${err.message}`);
        return [];
    }
}
