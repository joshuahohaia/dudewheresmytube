import rawLines from '../data/tfl_lines.json';
import rawStations from '../data/tfl_stations.json';
import type { FeatureCollection, LineString, Point } from 'geojson';

// Current IDs/sequence checked against TfL Northern Route/Sequence/inbound,
// 2026-11-10. Keep source drawing coordinates: API station entrances are not
// a replacement for track geometry. Only the motion graph needs these IDs.
const canonicalIds: Record<string, string> = {
  '940GZZLU990': '940GZZNEUGST',
  '940GZZLU991': '940GZZBPSUST',
};
export const motionStations: FeatureCollection<Point> = {
  type: 'FeatureCollection',
  features: (rawStations as FeatureCollection<Point>).features.map(feature => ({
    ...feature,
    properties: { ...feature.properties, id: canonicalIds[feature.properties?.id] || feature.properties?.id },
  })),
};

export const motionLines: FeatureCollection<LineString> = {
  type: 'FeatureCollection',
  features: (rawLines as FeatureCollection<LineString>).features.flatMap(feature => {
    if (feature.properties?.id !== 'BatterseaExtension') return [feature];
    const station = motionStations.features.find(f => f.properties?.id === '940GZZNEUGST');
    if (!station) return [feature];
    const coords = feature.geometry.coordinates;
    // Nine Elms already exists as a stored geometry vertex, not a new chord.
    const index = coords.findIndex(p => Math.abs(p[0] - station.geometry.coordinates[0]) < 1e-6 && Math.abs(p[1] - station.geometry.coordinates[1]) < 1e-6);
    if (index <= 0 || index >= coords.length - 1) return [feature];
    return [
      { from: '940GZZBPSUST', to: '940GZZNEUGST', path: coords.slice(0, index + 1) },
      { from: '940GZZNEUGST', to: '940GZZLUKNG', path: coords.slice(index) },
    ].map(leg => ({
      type: 'Feature' as const,
      properties: { id: `${leg.from}-${leg.to}`, lines: [{ name: 'Northern', start_sid: leg.from, end_sid: leg.to }] },
      geometry: { type: 'LineString' as const, coordinates: leg.path },
    }));
  }),
};
