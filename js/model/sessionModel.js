//------------------------------------------------------------
// SESSION MODEL — sessions directory, session key, drivers, circuit image
//------------------------------------------------------------

import { fetchWithRetry } from './api.js';
import { state } from './state.js';

const SESSIONS_URL = 'https://api.openf1.org/v1/sessions?session_name=Race';

function getSessionDataUrl(year, circuit_short_name) {
    return `https://api.openf1.org/v1/sessions?year=${year}&circuit_short_name=${circuit_short_name}&session_name=Race`;
}

function getDriversUrl() {
    return `https://api.openf1.org/v1/drivers?session_key=${state.sessionKey}`;
}

export async function loadSessionsDirectory() {
    const sessions = await fetchWithRetry(SESSIONS_URL, 'sessions') ?? [];

    state.years.length = 0;
    state.circuitsByYear = {};
    const seenYears = new Set();

    for (const s of sessions) {
        if (!seenYears.has(s.year)) {
            seenYears.add(s.year);
            state.years.push(s.year);
        }
        if (!state.circuitsByYear[s.year]) state.circuitsByYear[s.year] = [];
        const alreadyListed = state.circuitsByYear[s.year].some(
            c => c.circuit_short_name === s.circuit_short_name
        );
        if (!alreadyListed) state.circuitsByYear[s.year].push(s);
    }

    state.years.sort((a, b) => b - a);
    for (const year of Object.keys(state.circuitsByYear)) {
        state.circuitsByYear[year].sort((a, b) => a.circuit_short_name.localeCompare(b.circuit_short_name));
    }

    return sessions;
}

export async function setSessionKey(year, circuit_short_name) {
    const sessionData = await fetchWithRetry(
        getSessionDataUrl(year, circuit_short_name),
        'session'
    ) ?? [];

    state.currentSession = sessionData[0] ?? null;
    state.sessionKey = state.currentSession?.session_key ?? 0;
    return state.currentSession;
}

export async function getCircuitImageUrl(sessionKey) {
    try {
        const sessionRes = await fetch(`https://api.openf1.org/v1/sessions?session_key=${sessionKey}`);
        if (!sessionRes.ok) throw new Error(`HTTP ${sessionRes.status}`);
        const [session] = await sessionRes.json();
        if (!session?.meeting_key) return null;

        const meetingRes = await fetch(`https://api.openf1.org/v1/meetings?meeting_key=${session.meeting_key}`);
        if (!meetingRes.ok) throw new Error(`HTTP ${meetingRes.status}`);
        const [meeting] = await meetingRes.json();
        return meeting?.circuit_image ?? null;
    } catch (error) {
        console.log('Failed to fetch circuit image:', error);
        return null;
    }
}

export async function fetchDriversForSession() {
    return await fetchWithRetry(getDriversUrl(), 'drivers') ?? [];
}

export function refreshUniqueDrivers(driverList) {
    state.uniqueDrivers.length = 0;
    const seenNumbers = new Set();
    for (const d of driverList) {
        if (!seenNumbers.has(d.driver_number)) {
            seenNumbers.add(d.driver_number);
            state.uniqueDrivers.push(d);
        }
    }
    state.uniqueDrivers.sort((a, b) => a.driver_number - b.driver_number);
}

export function findDriverInfo(driverNumber) {
    return state.uniqueDrivers.find(d => d.driver_number === driverNumber);
}
