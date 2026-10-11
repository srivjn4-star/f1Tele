//------------------------------------------------------------
// READOUT VIEW — driver telemetry cards (headshot + live stats)
//------------------------------------------------------------

export function renderReadoutCardShell(car) {
    const el = document.getElementById(car.readoutId);
    if (!el) return;
    el.style.borderLeftColor = car.color;

    const headshotImg = car.info.headshot_url
        ? `<div class="readout-headshot-wrap"><img class="readout-headshot" src="${car.info.headshot_url}" alt="${car.info.full_name}" onerror="this.parentElement.style.display='none'"></div>`
        : '';

    el.innerHTML = `
        <div class="readout-header">
            ${headshotImg}
            <div class="readout-identity">
                <span class="readout-name" style="color:${car.color}">${car.info.full_name}</span>
                <span class="readout-team">${car.info.team_name || ''}</span>
            </div>
        </div>
        <div class="readout-stats-list">
            <div class="readout-stat-row">
                <span class="readout-stat-label">SPEED</span>
                <span class="readout-stat-value" id="${car.readoutId}-speed">-- <small>km/h</small></span>
            </div>
            <div class="readout-stat-row">
                <span class="readout-stat-label">THROTTLE</span>
                <span class="readout-stat-value" id="${car.readoutId}-throttle">-- <small>%</small></span>
            </div>
            <div class="readout-stat-row">
                <span class="readout-stat-label">BRAKE</span>
                <span class="readout-stat-value" id="${car.readoutId}-brake">--</span>
            </div>
            <div class="readout-stat-row">
                <span class="readout-stat-label">GEAR</span>
                <span class="readout-stat-value" id="${car.readoutId}-gear">--</span>
            </div>
        </div>
    `;
}

export function updateReadout(car, carDataPoint) {
    if (!car || !carDataPoint) return;
    const speedEl = document.getElementById(`${car.readoutId}-speed`);
    const throttleEl = document.getElementById(`${car.readoutId}-throttle`);
    const brakeEl = document.getElementById(`${car.readoutId}-brake`);
    const gearEl = document.getElementById(`${car.readoutId}-gear`);

    if (speedEl && carDataPoint.speed !== undefined) {
        speedEl.innerHTML = `${Math.round(carDataPoint.speed)} <small>km/h</small>`;
    }

    if (throttleEl && carDataPoint.throttle !== undefined) {
        throttleEl.innerHTML = `${Math.round(carDataPoint.throttle)} <small>%</small>`;
    }

    if (brakeEl) {
        const isBraking = carDataPoint.brake === true || carDataPoint.brake === 1 || Number(carDataPoint.brake) > 0;
        const brakeText = isBraking
            ? (Number(carDataPoint.brake) > 1 ? `${Math.round(carDataPoint.brake)}%` : 'ON')
            : 'OFF';
        brakeEl.textContent = brakeText;
        brakeEl.style.color = isBraking ? '#ff3b30' : 'var(--text-dim)';
    }

    if (gearEl && carDataPoint.n_gear !== undefined) {
        gearEl.textContent = carDataPoint.n_gear;
    }
}
