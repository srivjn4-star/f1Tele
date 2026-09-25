//------------------------------------------------------------
// ALERT VIEW — bottom-left session status cubes
//------------------------------------------------------------

import { state } from '../model/state.js';

const SESSION_ALERT_IDS = [
    'sessionNotStartedAlert',
    'sessionInProgressAlert',
    'sessionFinishedAlert'
];

export function hideAllSessionAlerts() {
    SESSION_ALERT_IDS.forEach(id => {
        document.getElementById(id).hidden = true;
    });
}

export function showSessionAlert(alertId) {
    document.getElementById(alertId).hidden = false;
}

// Shows exactly one alert based on date_start / date_end vs now (mutually exclusive).
export function updateAlertsForSession() {
    hideAllSessionAlerts();
    if (!state.currentSession?.date_start) return;

    const now = Date.now();
    const startMs = new Date(state.currentSession.date_start).getTime();
    const endMs = state.currentSession.date_end
        ? new Date(state.currentSession.date_end).getTime()
        : null;

    if (now < startMs) {
        showSessionAlert('sessionNotStartedAlert');
    } else if (endMs && now < endMs) {
        showSessionAlert('sessionInProgressAlert');
    } else if (endMs && now >= endMs) {
        showSessionAlert('sessionFinishedAlert');
    } else if (!endMs && now >= startMs) {
        showSessionAlert('sessionFinishedAlert');
    }
}

export function wireAlertCloseButtons() {
    document.querySelectorAll('.alert-cube__close').forEach(btn => {
        btn.addEventListener('click', () => {
            const cube = btn.closest('.alert-cube');
            if (cube) cube.hidden = true;
        });
    });
}
