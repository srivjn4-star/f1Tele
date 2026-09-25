//------------------------------------------------------------
// LAPS TABLE VIEW — lap data tables for both drivers
//------------------------------------------------------------

import { LAP_COLUMN_NAMES } from '../model/telemetryModel.js';

function buildHeaderRow(tableElement) {
    const headerRow = document.createElement('tr');
    LAP_COLUMN_NAMES.forEach(name => {
        const th = document.createElement('th');
        th.textContent = name;
        headerRow.appendChild(th);
    });
    tableElement.appendChild(headerRow);
}

function addRows(laps, tableElement) {
    laps.forEach(lap => {
        const currRow = document.createElement('tr');
        LAP_COLUMN_NAMES.forEach(name => {
            const td = document.createElement('td');
            td.textContent = lap[name];
            currRow.appendChild(td);
        });
        tableElement.appendChild(currRow);
    });
}

export function renderLapsTable(laps, tableElement) {
    tableElement.innerHTML = "";
    buildHeaderRow(tableElement);
    addRows(laps, tableElement);
}
