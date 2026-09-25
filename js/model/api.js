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
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
    } catch (error) {
        console.log(`Failed to fetch ${label}:`, error);
        return null;
    }
}
