export function routeToGeoJSON(route) {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {
          label: route.label,
          length_m: route.result.length_m,
          max_grade_percent: route.result.max_grade_percent,
          min_curve_radius_m: route.result.min_curve_radius_m,
          cut_volume_m3: route.result.earthwork?.cut_volume_m3 ?? null,
          fill_volume_m3: route.result.earthwork?.fill_volume_m3 ?? null,
          bridge_length_m: route.result.earthwork?.bridge_length_m ?? null,
          road_width_m: route.roadWidthM,
        },
        geometry: {
          type: "LineString",
          coordinates: route.result.path.map((p) => [p.lng, p.lat]),
        },
      },
    ],
  };
}

export function combinedGeoJSON(routes) {
  return {
    type: "FeatureCollection",
    features: routes.map((route) => routeToGeoJSON(route).features[0]),
  };
}

export function routeToCSV(route) {
  const sections = route.result.earthwork?.sections || [];
  const header = [
    "distance_m",
    "terrain_elevation_m",
    "design_elevation_m",
    "cut_depth_m",
    "fill_depth_m",
    "is_bridge",
  ];
  const lines = [header.join(",")];
  for (const s of sections) {
    lines.push(
      [s.distance_m, s.terrain_elevation_m, s.design_elevation_m, s.cut_depth_m, s.fill_depth_m, s.is_bridge].join(
        ","
      )
    );
  }
  return lines.join("\n");
}

export function downloadText(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
