const API_BASE = "http://localhost:8000/api";

export async function uploadDem(files) {
  const formData = new FormData();
  for (const file of files) {
    formData.append("files", file);
  }

  const res = await fetch(`${API_BASE}/dem/upload`, {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.detail || `업로드 실패 (${res.status})`);
  }

  return res.json();
}

export function hillshadeUrl(demId) {
  return `${API_BASE}/dem/${demId}/hillshade`;
}

export function slopeUrl(demId) {
  return `${API_BASE}/dem/${demId}/slope`;
}

export function elevationHeatmapUrl(demId) {
  return `${API_BASE}/dem/${demId}/elevation-heatmap`;
}

export async function fetchContours(demId) {
  const res = await fetch(`${API_BASE}/dem/${demId}/contours`);
  if (!res.ok) throw new Error(`등고선 조회 실패 (${res.status})`);
  return res.json();
}

export async function fetchElevation(demId, lat, lng) {
  const res = await fetch(`${API_BASE}/dem/${demId}/elevation?lat=${lat}&lng=${lng}`);
  if (!res.ok) throw new Error(`고도 조회 실패 (${res.status})`);
  return res.json();
}

export async function findRoute(demId, waypoints, roadWidthM) {
  const res = await fetch(`${API_BASE}/dem/${demId}/route`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ waypoints, road_width_m: roadWidthM }),
  });

  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.detail || `노선 탐색 실패 (${res.status})`);
  }

  return res.json();
}
