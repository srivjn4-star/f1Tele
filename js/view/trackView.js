//------------------------------------------------------------
// TRACK VIEW — coordinate mapping, SVG track, sector colours, markers
//------------------------------------------------------------

import { state } from '../model/state.js';

export function createCoordinateMapper(allPoints, canvasWidth, canvasHeight, padding = 20) {
    const xs = allPoints.map(p => p.x);
    const ys = allPoints.map(p => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const dataWidth = maxX - minX;
    const dataHeight = maxY - minY;
    const usableWidth = canvasWidth - padding * 2;
    const usableHeight = canvasHeight - padding * 2;
    const scale = Math.min(usableWidth / dataWidth, usableHeight / dataHeight);
    return function toPixel(point) {
        return {
            pixelX: (point.x - minX) * scale + padding,
            pixelY: (point.y - minY) * scale + padding
        };
    };
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

export function findNearestLocalIndex(sessionArray, centerIndex, mouseX, mouseY, window = 50) {
    const start = Math.max(0, centerIndex - window);
    const end = Math.min(sessionArray.length - 1, centerIndex + window);
    let nearestIndex = centerIndex;
    let nearestDistSq = Infinity;
    for (let i = start; i <= end; i++) {
        const dx = sessionArray[i].pixelX - mouseX;
        const dy = sessionArray[i].pixelY - mouseY;
        const distSq = dx * dx + dy * dy;
        if (distSq < nearestDistSq) {
            nearestDistSq = distSq;
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
