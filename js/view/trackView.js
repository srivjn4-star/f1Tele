//------------------------------------------------------------
// TRACK VIEW — coordinate mapping, SVG track, sector colours, markers
//------------------------------------------------------------

import { state } from '../model/state.js';

export function createCoordinateMapper(allPoints, canvasWidth, canvasHeight, padding = 25) {
    const xs = allPoints.map(p => p.x);
    const ys = allPoints.map(p => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const dataWidth = maxX - minX;
    const dataHeight = maxY - minY;

    // Check if circuit is very large vertically (height > width * 1.15)
    const shouldRotate = dataHeight > dataWidth * 1.15;
    const usableWidth = canvasWidth - padding * 2;
    const usableHeight = canvasHeight - padding * 2;

    if (shouldRotate) {
        // Rotate 90 degrees clockwise: (x, y) -> (y, -x)
        const rxs = allPoints.map(p => p.y);
        const rys = allPoints.map(p => -p.x);
        const minRX = Math.min(...rxs);
        const maxRX = Math.max(...rxs);
        const minRY = Math.min(...rys);
        const maxRY = Math.max(...rys);
        const rWidth = maxRX - minRX;
        const rHeight = maxRY - minRY;
        const scale = Math.min(usableWidth / rWidth, usableHeight / rHeight);
        const offsetX = (usableWidth - rWidth * scale) / 2 + padding;
        const offsetY = (usableHeight - rHeight * scale) / 2 + padding;

        return function toPixel(point) {
            const rx = point.y;
            const ry = -point.x;
            return {
                pixelX: (rx - minRX) * scale + offsetX,
                pixelY: (ry - minRY) * scale + offsetY
            };
        };
    } else {
        const scale = Math.min(usableWidth / dataWidth, usableHeight / dataHeight);
        const offsetX = (usableWidth - dataWidth * scale) / 2 + padding;
        const offsetY = (usableHeight - dataHeight * scale) / 2 + padding;

        return function toPixel(point) {
            return {
                pixelX: (point.x - minX) * scale + offsetX,
                pixelY: (point.y - minY) * scale + offsetY
            };
        };
    }
}

export function findBestReferenceLap(driverALaps, driverALocation, driverBLaps, driverBLocation) {
    let best = null;

    function consider(laps, location) {
        laps.forEach((lap, i) => {
            const points = location[i];
            if (!points || points.length < 20) return;
            if (lap.is_pit_out_lap) return;
            if (!lap.lap_duration) return;
            if (!best || lap.lap_duration < best.lapDuration) {
                best = { points, lapDuration: lap.lap_duration, lapIndex: i, lap };
            }
        });
    }

    consider(driverALaps, driverALocation);
    consider(driverBLaps, driverBLocation);
    return best;
}

function buildTrackPath(pixelPoints) {
    const [first, ...rest] = pixelPoints;
    let d = `M ${first.pixelX} ${first.pixelY}`;
    for (const point of rest) {
        d += ` L ${point.pixelX} ${point.pixelY}`;
    }
    return d;
}

function splitPointsBySector(points, lap) {
    if (!lap.duration_sector_1 || !lap.duration_sector_2 || !lap.duration_sector_3) {
        return null;
    }
    const sector1End = lap.duration_sector_1;
    const sector2End = sector1End + lap.duration_sector_2;

    function sectorOf(point) {
        if (point.elapsedSeconds <= sector1End) return 1;
        if (point.elapsedSeconds <= sector2End) return 2;
        return 3;
    }

    const paths = { 1: [], 2: [], 3: [] };
    points.forEach((point, i) => {
        const sector = sectorOf(point);
        paths[sector].push(point);
        const next = points[i + 1];
        if (next && sectorOf(next) !== sector) {
            paths[sectorOf(next)].push(point);
        }
    });
    return paths;
}

function buildSectorLabels(sectorPaths) {
    const labels = { 1: 'SECTOR 1', 2: 'SECTOR 2', 3: 'SECTOR 3' };
    let svg = '';

    [1, 2, 3].forEach(sectorNum => {
        const pts = sectorPaths[sectorNum];
        if (!pts || pts.length < 7) return;

        const midIdx = Math.floor(pts.length / 2);
        const before = pts[Math.max(0, midIdx - 3)];
        const after = pts[Math.min(pts.length - 1, midIdx + 3)];
        const mid = pts[midIdx];

        let angle = (Math.atan2(after.pixelY - before.pixelY, after.pixelX - before.pixelX) * 180) / Math.PI;
        if (angle > 90 || angle < -90) angle += 180;

        svg += `
            <text x="${mid.pixelX}" y="${mid.pixelY}" dy="-7"
                  transform="rotate(${angle} ${mid.pixelX} ${mid.pixelY})"
                  text-anchor="middle" class="sector-label track-sector-${sectorNum}">${labels[sectorNum]}</text>
        `;
    });

    return svg;
}

function buildCheckerFlag(p0, angleDegrees, width = 34, thickness = 8, cols = 2, rows = 6) {
    const cellW = thickness / cols;
    const cellH = width / rows;
    let rects = '';
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const fill = (r + c) % 2 === 0 ? '#fff' : '#111';
            const x = -thickness / 2 + c * cellW;
            const y = -width / 2 + r * cellH;
            rects += `<rect x="${x}" y="${y}" width="${cellW}" height="${cellH}" fill="${fill}" stroke="#666" stroke-width="0.5" />`;
        }
    }
    return `<g transform="translate(${p0.pixelX} ${p0.pixelY}) rotate(${angleDegrees})">${rects}</g>`;
}

function buildDirectionArrow(p0, angleDegrees, distanceAhead = 26, size = 9) {
    const rad = (angleDegrees * Math.PI) / 180;
    const cx = p0.pixelX + Math.cos(rad) * distanceAhead;
    const cy = p0.pixelY + Math.sin(rad) * distanceAhead;
    return `
        <g transform="translate(${cx} ${cy}) rotate(${angleDegrees})">
            <polygon points="${size},0 ${-size / 2},${size * 0.7} ${-size / 2},${-size * 0.7}" fill="#ffb800" />
        </g>
    `;
}

export function flattenLapData(perLapArray) {
    const flat = [];
    perLapArray.forEach((lapPoints, lapIndex) => {
        lapPoints.forEach((point, pointIndex) => {
            flat.push({ ...point, lapIndex, pointIndex });
        });
    });
    return flat;
}

export function buildLapStartIndex(sessionArray) {
    const starts = [];
    sessionArray.forEach((point, i) => {
        if (starts[point.lapIndex] === undefined) starts[point.lapIndex] = i;
    });
    return starts;
}

export function findNearestLocalIndex(sessionArray, centerIndex, mouseX, mouseY, window = 25) {
    const start = Math.max(0, centerIndex - window);
    const end = Math.min(sessionArray.length - 1, centerIndex + window);
    let nearestIndex = centerIndex;
    let nearestScore = Infinity;
    for (let i = start; i <= end; i++) {
        const dx = sessionArray[i].pixelX - mouseX;
        const dy = sessionArray[i].pixelY - mouseY;
        const distSq = dx * dx + dy * dy;
        const score = distSq + Math.abs(i - centerIndex) * 1.5;
        if (score < nearestScore) {
            nearestScore = score;
            nearestIndex = i;
        }
    }
    return nearestIndex;
}

export function findNearestByTime(sessionArray, targetTimeMs) {
    let nearestIndex = 0;
    let smallestDiff = Infinity;
    sessionArray.forEach((point, i) => {
        const diff = Math.abs(new Date(point.date).getTime() - targetTimeMs);
        if (diff < smallestDiff) {
            smallestDiff = diff;
            nearestIndex = i;
        }
    });
    return nearestIndex;
}

export function findNearestCarDataPoint(carDataLap, targetDate) {
    const targetTime = new Date(targetDate).getTime();
    let nearest = carDataLap[0];
    let smallestDiff = Infinity;
    for (const point of carDataLap) {
        const diff = Math.abs(new Date(point.date).getTime() - targetTime);
        if (diff < smallestDiff) {
            smallestDiff = diff;
            nearest = point;
        }
    }
    return nearest;
}

export function getRaceProgress(point, driverLaps) {
    const lap = driverLaps[point.lapIndex];
    return point.lapIndex + (point.elapsedSeconds / lap.lap_duration);
}

export function renderTrack(containerId, trackPixelPoints, aPixel, bPixel, referenceLapRecord) {
    const container = document.getElementById(containerId);

    const p0 = trackPixelPoints[0];
    const p1 = trackPixelPoints[1];
    const angleDegrees = (Math.atan2(p1.pixelY - p0.pixelY, p1.pixelX - p0.pixelX) * 180) / Math.PI;

    const basePathSvg = `<path d="${buildTrackPath(trackPixelPoints)}" class="track-base" stroke-width="15" fill="none" stroke-linecap="round" stroke-linejoin="round" />`;

    const sectorPaths = splitPointsBySector(trackPixelPoints, referenceLapRecord);
    const sectorPathSvg = sectorPaths
        ? `
            <path d="${buildTrackPath(sectorPaths[1])}" class="track-sector-1" stroke-width="2" fill="none" stroke-linecap="round" />
            <path d="${buildTrackPath(sectorPaths[2])}" class="track-sector-2" stroke-width="2" fill="none" stroke-linecap="round" />
            <path d="${buildTrackPath(sectorPaths[3])}" class="track-sector-3" stroke-width="2" fill="none" stroke-linecap="round" />
        `
        : `<path d="${buildTrackPath(trackPixelPoints)}" stroke="#aaa" stroke-width="2" fill="none" />`;

    const sectorLabelsSvg = sectorPaths ? buildSectorLabels(sectorPaths) : '';
    const checkerFlagSvg = buildCheckerFlag(p0, angleDegrees);
    const directionArrowSvg = buildDirectionArrow(p0, angleDegrees);

    container.innerHTML = `
        <svg viewBox="0 0 800 500" width="800" height="500" class="track-svg">
            ${basePathSvg}
            ${sectorPathSvg}
            ${sectorLabelsSvg}
            ${checkerFlagSvg}
            ${directionArrowSvg}
            <circle id="driverACarMarker" cx="${aPixel.pixelX}" cy="${aPixel.pixelY}" r="8" fill="${state.carState.a.color}" />
            <circle id="driverBCarMarker" cx="${bPixel.pixelX}" cy="${bPixel.pixelY}" r="8" fill="${state.carState.b.color}" />
        </svg>
    `;
}

// Stadium Loop geometry constants
const LOOP_W = 200;
const LOOP_H = 52;
const LOOP_R = 21;
const LOOP_L = 148; // 174 - 26
const LOOP_PERIMETER = 2 * LOOP_L + 2 * Math.PI * LOOP_R; // ~427.95

export function getScrubberPoint(progress) {
    const p = Math.max(0, Math.min(1, progress));
    const s = p * LOOP_PERIMETER;
    const arcLen = Math.PI * LOOP_R;

    if (s <= LOOP_L) {
        // Top straight (left to right)
        return { x: 26 + s, y: 5 };
    } else if (s <= LOOP_L + arcLen) {
        // Right semicircle (top to bottom)
        const angle = -Math.PI / 2 + (s - LOOP_L) / LOOP_R;
        return {
            x: 174 + LOOP_R * Math.cos(angle),
            y: 26 + LOOP_R * Math.sin(angle)
        };
    } else if (s <= 2 * LOOP_L + arcLen) {
        // Bottom straight (right to left)
        const ds = s - (LOOP_L + arcLen);
        return { x: 174 - ds, y: 47 };
    } else {
        // Left semicircle (bottom to top)
        const ds = s - (2 * LOOP_L + arcLen);
        const angle = Math.PI / 2 + ds / LOOP_R;
        return {
            x: 26 + LOOP_R * Math.cos(angle),
            y: 26 + LOOP_R * Math.sin(angle)
        };
    }
}

export function getScrubberProgressFromMouse(mx, my) {
    const arcLen = Math.PI * LOOP_R;
    let s = 0;

    if (mx < 26) {
        // Left semicircle
        let angle = Math.atan2(my - 26, mx - 26);
        let a = angle - Math.PI / 2;
        if (a < 0) a += 2 * Math.PI;
        if (a > Math.PI) a = Math.PI;
        s = 2 * LOOP_L + arcLen + (a * LOOP_R);
    } else if (mx > 174) {
        // Right semicircle
        let angle = Math.atan2(my - 26, mx - 174);
        let a = angle - (-Math.PI / 2);
        if (a < 0) a += 2 * Math.PI;
        if (a > Math.PI) a = Math.PI;
        s = LOOP_L + (a * LOOP_R);
    } else {
        // Straight sections (26 <= mx <= 174)
        if (my <= 26) {
            s = mx - 26;
        } else {
            s = LOOP_L + arcLen + (174 - mx);
        }
    }

    return Math.max(0, Math.min(1, s / LOOP_PERIMETER));
}

export function renderScrubberWidget(containerId, driverA, driverB, activeDriver = 'a') {
    const container = document.getElementById(containerId);
    if (!container) return;

    const existing = container.querySelector('.scrubber-loop-wrap');
    if (existing) existing.remove();

    const acronymA = driverA.info.name_acronym || driverA.info.last_name?.slice(0, 3)?.toUpperCase() || 'DRV A';
    const acronymB = driverB.info.name_acronym || driverB.info.last_name?.slice(0, 3)?.toUpperCase() || 'DRV B';

    const wrap = document.createElement('div');
    wrap.className = 'scrubber-loop-wrap';
    wrap.id = 'scrubberLoopWrap';

    const initialPoint = getScrubberPoint(0);
    const activeColor = activeDriver === 'a' ? driverA.color : driverB.color;

    wrap.innerHTML = `
        <div class="scrubber-svg-container">
            <svg viewBox="0 0 200 52" id="scrubberSvg">
                <path d="M 26 5 L 174 5 A 21 21 0 0 1 174 47 L 26 47 A 21 21 0 0 1 26 5 Z" stroke="#16161b" stroke-width="12" fill="none" stroke-linecap="round" />
                <path d="M 26 5 L 174 5 A 21 21 0 0 1 174 47 L 26 47 A 21 21 0 0 1 26 5 Z" stroke="#2c2c36" stroke-width="5" fill="none" stroke-linecap="round" />
                <!-- Forward direction flow arrows -->
                <polygon points="106,2 112,5 106,8" fill="#ffb800" opacity="0.85" />
                <polygon points="94,44 88,47 94,50" fill="#ffb800" opacity="0.85" />
                <circle id="scrubberKnob" cx="${initialPoint.x}" cy="${initialPoint.y}" r="8" fill="${activeColor}" stroke="#ffffff" stroke-width="2" />
            </svg>
            <div class="scrubber-center-ctrls">
                <button type="button" id="scrubberDriverABtn" class="loop-driver-btn ${activeDriver === 'a' ? 'loop-driver-btn--active' : ''}">${acronymA}</button>
                <button type="button" id="scrubberDriverBBtn" class="loop-driver-btn ${activeDriver === 'b' ? 'loop-driver-btn--active' : ''}">${acronymB}</button>
            </div>
        </div>
    `;

    container.appendChild(wrap);
    updateScrubberActiveDriver(activeDriver, driverA.color, driverB.color);
}

export function updateScrubberActiveDriver(activeDriver, colorA, colorB) {
    const btnA = document.getElementById('scrubberDriverABtn');
    const btnB = document.getElementById('scrubberDriverBBtn');
    const knob = document.getElementById('scrubberKnob');

    if (btnA && btnB) {
        if (activeDriver === 'a') {
            btnA.classList.add('loop-driver-btn--active');
            btnA.style.background = colorA;
            btnA.style.color = '#000';
            btnB.classList.remove('loop-driver-btn--active');
            btnB.style.background = 'transparent';
            btnB.style.color = '#8a8a90';
            if (knob) knob.setAttribute('fill', colorA);
        } else {
            btnB.classList.add('loop-driver-btn--active');
            btnB.style.background = colorB;
            btnB.style.color = '#000';
            btnA.classList.remove('loop-driver-btn--active');
            btnA.style.background = 'transparent';
            btnA.style.color = '#8a8a90';
            if (knob) knob.setAttribute('fill', colorB);
        }
    }
}

export function updateScrubberKnob(progress, color) {
    const knob = document.getElementById('scrubberKnob');
    if (!knob) return;
    const pt = getScrubberPoint(progress);
    knob.setAttribute('cx', pt.x);
    knob.setAttribute('cy', pt.y);
    if (color) knob.setAttribute('fill', color);
}
