import { useEffect, useRef, useState } from "react";

function decimate(sections, targetCount) {
  if (sections.length <= targetCount) return sections;
  const step = Math.ceil(sections.length / targetCount);
  const out = sections.filter((_, i) => i % step === 0);
  if (out[out.length - 1] !== sections[sections.length - 1]) {
    out.push(sections[sections.length - 1]);
  }
  return out;
}

export default function ElevationProfile({ lengthM, maxGradePercent, earthwork, height = 220 }) {
  const svgWrapRef = useRef(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const el = svgWrapRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      setSize({ width, height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const sections = earthwork?.sections;
  if (!sections || sections.length === 0) return null;

  const pts = decimate(sections, 600);

  const viewWidth = size.width || 760;
  const viewHeight = size.height || 160;
  const padding = 34;

  const maxDist = pts[pts.length - 1].distance_m || 1;
  const allElev = pts.flatMap((p) => [p.terrain_elevation_m, p.design_elevation_m]);
  const minElev = Math.min(...allElev);
  const maxElev = Math.max(...allElev);
  const elevRange = maxElev - minElev || 1;

  const xScale = (d) => padding + (d / maxDist) * (viewWidth - 2 * padding);
  const yScale = (e) => viewHeight - padding - ((e - minElev) / elevRange) * (viewHeight - 2 * padding);

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

  const bridgeSegments = [];
  let current = [];
  pts.forEach((p) => {
    if (p.is_bridge) {
      current.push(`${xScale(p.distance_m)},${yScale(p.design_elevation_m)}`);
    } else if (current.length) {
      bridgeSegments.push(current.join(" "));
      current = [];
    }
  });
  if (current.length) bridgeSegments.push(current.join(" "));

  const bridgeLengthM = earthwork.bridge_length_m || 0;

  return (
    <div
      style={{
        background: "white",
        padding: "10px 12px",
        boxShadow: "0 -2px 6px rgba(0,0,0,0.06)",
        height,
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <div style={{ fontSize: 13, marginBottom: 6, color: "#333", fontWeight: 500, flexShrink: 0 }}>
        종단면도 — 거리 {(lengthM / 1000).toFixed(2)}km · 최대경사 {maxGradePercent.toFixed(1)}% · 절토{" "}
        {(earthwork.cut_volume_m3 / 1000).toFixed(1)}천㎥ · 성토 {(earthwork.fill_volume_m3 / 1000).toFixed(1)}천㎥
        {bridgeLengthM > 0 && ` · 교량 ${bridgeLengthM.toFixed(0)}m`}
        <span style={{ fontWeight: 400, color: "#777" }}> (도로폭 {earthwork.road_width_m}m 가정)</span>
      </div>
      <div ref={svgWrapRef} style={{ flex: 1, minHeight: 0 }}>
        <svg viewBox={`0 0 ${viewWidth} ${viewHeight}`} width="100%" height="100%">
          <polygon points={cutPolygon} fill="#c62828" fillOpacity="0.35" stroke="none" />
          <polygon points={fillPolygon} fill="#1565c0" fillOpacity="0.35" stroke="none" />
          <polyline points={terrainPoints} fill="none" stroke="#555" strokeWidth="1.5" />
          <polyline points={designPoints} fill="none" stroke="#1f6feb" strokeWidth="2" />
          {bridgeSegments.map((points, i) => (
            <polyline key={i} points={points} fill="none" stroke="#6a1b9a" strokeWidth="4" />
          ))}
          <text x={padding} y={14} fontSize="11" fill="#333">
            {maxElev.toFixed(0)}m
          </text>
          <text x={padding} y={viewHeight - padding + 14} fontSize="11" fill="#333">
            {minElev.toFixed(0)}m
          </text>
          <text x={viewWidth - padding} y={14} fontSize="11" fill="#555" textAnchor="end">
            회색: 지형 / 파랑: 설계선{bridgeSegments.length > 0 && " / 보라: 교량"}
          </text>
        </svg>
      </div>
    </div>
  );
}
