function decimate(sections, targetCount) {
  if (sections.length <= targetCount) return sections;
  const step = Math.ceil(sections.length / targetCount);
  const out = sections.filter((_, i) => i % step === 0);
  if (out[out.length - 1] !== sections[sections.length - 1]) {
    out.push(sections[sections.length - 1]);
  }
  return out;
}

export default function ElevationProfile({ lengthM, maxGradePercent, earthwork }) {
  const sections = earthwork?.sections;
  if (!sections || sections.length === 0) return null;

  const pts = decimate(sections, 600);

  const width = 760;
  const height = 200;
  const padding = 34;

  const maxDist = pts[pts.length - 1].distance_m || 1;
  const allElev = pts.flatMap((p) => [p.terrain_elevation_m, p.design_elevation_m]);
  const minElev = Math.min(...allElev);
  const maxElev = Math.max(...allElev);
  const elevRange = maxElev - minElev || 1;

  const xScale = (d) => padding + (d / maxDist) * (width - 2 * padding);
  const yScale = (e) => height - padding - ((e - minElev) / elevRange) * (height - 2 * padding);

  const terrainPoints = pts.map((p) => `${xScale(p.distance_m)},${yScale(p.terrain_elevation_m)}`).join(" ");
  const designPoints = pts.map((p) => `${xScale(p.distance_m)},${yScale(p.design_elevation_m)}`).join(" ");

  const cutTop = pts.map((p) =>
    p.terrain_elevation_m > p.design_elevation_m ? p.terrain_elevation_m : p.design_elevation_m
  );
  const fillBottom = pts.map((p) =>
    p.terrain_elevation_m < p.design_elevation_m ? p.terrain_elevation_m : p.design_elevation_m
  );

  const cutForward = pts.map((p, i) => `${xScale(p.distance_m)},${yScale(cutTop[i])}`);
  const designBackward = [...pts].reverse().map((p) => `${xScale(p.distance_m)},${yScale(p.design_elevation_m)}`);
  const cutPolygon = [...cutForward, ...designBackward].join(" ");

  const fillForward = pts.map((p, i) => `${xScale(p.distance_m)},${yScale(fillBottom[i])}`);
  const fillPolygon = [...fillForward, ...designBackward].join(" ");

  return (
    <div style={{ background: "white", padding: "10px 12px", borderTop: "1px solid #d6d9dd", boxShadow: "0 -2px 6px rgba(0,0,0,0.06)" }}>
      <div style={{ fontSize: 13, marginBottom: 6, color: "#333", fontWeight: 500 }}>
        종단면도 — 거리 {(lengthM / 1000).toFixed(2)}km · 최대경사 {maxGradePercent.toFixed(1)}% · 절토{" "}
        {(earthwork.cut_volume_m3 / 1000).toFixed(1)}천㎥ · 성토 {(earthwork.fill_volume_m3 / 1000).toFixed(1)}천㎥
        <span style={{ fontWeight: 400, color: "#777" }}> (도로폭 {earthwork.road_width_m}m 가정)</span>
      </div>
      <svg width={width} height={height}>
        <polygon points={cutPolygon} fill="#c62828" fillOpacity="0.35" stroke="none" />
        <polygon points={fillPolygon} fill="#1565c0" fillOpacity="0.35" stroke="none" />
        <polyline points={terrainPoints} fill="none" stroke="#555" strokeWidth="1.5" />
        <polyline points={designPoints} fill="none" stroke="#1f6feb" strokeWidth="2" />
        <text x={padding} y={14} fontSize="11" fill="#333">
          {maxElev.toFixed(0)}m
        </text>
        <text x={padding} y={height - padding + 14} fontSize="11" fill="#333">
          {minElev.toFixed(0)}m
        </text>
        <text x={width - padding} y={14} fontSize="11" fill="#555" textAnchor="end">
          회색: 지형 / 파랑: 설계선
        </text>
      </svg>
    </div>
  );
}
