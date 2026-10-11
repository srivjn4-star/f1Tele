//------------------------------------------------------------
// API — shared fetch helper with rate-limit retry
//------------------------------------------------------------

export async function fetchWithRetry(url, label, retries = 3) {
    try {
        const response = await fetch(url);
        if (response.status === 429 && retries > 0) {
            console.log(`Rate limited fetching ${label}, retrying in 2s... (${retries} left)`);
            await new Promise(resolve => setTimeout(resolve, 2000));
            return fetchWithRetry(url, label, retries - 1);
        }
        if (response.status === 404) {
            console.warn(`[OpenF1 404] Resource not found for ${label}: ${url}`);
            return null;
        }
        if (response.status === 401 || response.status === 403) {
            const err = new Error(`HTTP ${response.status} Unauthorized (Live Session)`);
            err.status = response.status;
            throw err;
        }
        if (!response.ok) {
            const err = new Error(`HTTP ${response.status}`);
            err.status = response.status;
            throw err;
        }
        return await response.json();
    } catch (error) {
        console.log(`Failed to fetch ${label}:`, error);
        // Bubble up errors so the UI can show rate limit or live session alerts
        throw error;
    }
}
