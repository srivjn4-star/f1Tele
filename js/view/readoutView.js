//------------------------------------------------------------
// READOUT VIEW — driver telemetry cards (headshot + live stats)
//------------------------------------------------------------

export function renderReadoutCardShell(car) {
    const el = document.getElementById(car.readoutId);
    el.style.borderLeftColor = car.color;
    el.innerHTML = `
        <img src="${car.info.headshot_url || ''}" alt="${car.info.full_name}">
        <div class="readout-info">
            <span class="readout-name" style="color:${car.color}">${car.info.full_name}</span>
            <span class="readout-team">${car.info.team_name}</span>
            <span class="readout-telemetry" id="${car.readoutId}-telemetry">Drag the car on the track to see live telemetry</span>
        </div>
    `;
}

export function updateReadout(car, carDataPoint) {
    const telemetryEl = document.getElementById(`${car.readoutId}-telemetry`);
    telemetryEl.textContent = `Speed: ${carDataPoint.speed} km/h | Throttle: ${carDataPoint.throttle}% | Gear: ${carDataPoint.n_gear}`;
}
