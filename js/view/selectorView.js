//------------------------------------------------------------
// SELECTOR VIEW — dropdowns and session subhead
//------------------------------------------------------------

import { state } from '../model/state.js';

export function populateYearSelect(selectEl) {
    selectEl.innerHTML = "";
    state.years.forEach(year => {
        const option = document.createElement('option');
        option.value = year;
        option.textContent = year;
        selectEl.appendChild(option);
    });
}

export function populateCircuitSelect(selectEl, year) {
    selectEl.innerHTML = "";
    const circuits = state.circuitsByYear[year] ?? [];
    circuits.forEach(session => {
        const option = document.createElement('option');
        option.value = session.circuit_short_name;
        option.textContent = session.circuit_short_name;
        selectEl.appendChild(option);
    });
}

export function populateDriverSelect(selectEl) {
    selectEl.innerHTML = "";
    state.uniqueDrivers.forEach(d => {
        const option = document.createElement('option');
        option.value = d.driver_number;
        option.textContent = `${d.name_acronym} — ${d.full_name}`;
        selectEl.appendChild(option);
    });
}

export function updateSessionSubhead(subheadEl) {
    if (!state.currentSession) {
        subheadEl.textContent = "Select a year and circuit below";
        return;
    }
    subheadEl.textContent = `${state.currentSession.circuit_short_name} — ${state.currentSession.year} — Session ${state.currentSession.session_key}`;
}

export function renderCircuitImage(containerId, imageUrl, circuitName) {
    const container = document.getElementById(containerId);
    if (!container) return;
    if (!imageUrl) {
        container.innerHTML = "";
        return;
    }
    container.innerHTML = `<img src="${imageUrl}" alt="${circuitName ?? 'Circuit'} layout" class="circuit-image" />`;
}
