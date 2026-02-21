import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import { getLineColor, isUndergroundLine } from '../../lib/lineColors';
import linesData from '../../data/tfl_lines.json';
import stationsData from '../../data/tfl_stations.json';
import type { FeatureCollection, Feature, LineString, Point } from 'geojson';

// Filter to only Underground lines
function filterUndergroundLines(data: FeatureCollection): FeatureCollection<LineString> {
  return {
    type: 'FeatureCollection',
    features: data.features.filter((feature: Feature) => {
      const lines = feature.properties?.lines || [];
      return lines.some((line: { name: string }) => isUndergroundLine(line.name));
    }).map((feature: Feature) => ({
      ...feature,
      properties: {
        ...feature.properties,
        // Get the first underground line name for coloring
        lineName: feature.properties?.lines?.find((line: { name: string }) =>
          isUndergroundLine(line.name)
        )?.name || 'Unknown',
      },
    })),
  } as FeatureCollection<LineString>;
}

function filterUndergroundStations(data: FeatureCollection): FeatureCollection<Point> {
  return {
    type: 'FeatureCollection',
    features: data.features.filter((feature: Feature) => {
      const lines = feature.properties?.lines || [];
      return lines.some((line: { name: string }) => isUndergroundLine(line.name));
    }),
  } as FeatureCollection<Point>;
}

export function TubeMap() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);

  useEffect(() => {
    if (map.current || !mapContainer.current) return;

    // Initialize map with dark style
    map.current = new maplibregl.Map({
      container: mapContainer.current,
      style: {
        version: 8,
        name: 'Dark Minimal',
        sources: {
          'carto-dark': {
            type: 'raster',
            tiles: [
              'https://a.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}@2x.png',
              'https://b.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}@2x.png',
              'https://c.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}@2x.png',
            ],
            tileSize: 256,
            attribution: '&copy; <a href="https://carto.com/">CARTO</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
          },
        },
        layers: [
          {
            id: 'carto-dark-layer',
            type: 'raster',
            source: 'carto-dark',
            minzoom: 0,
            maxzoom: 22,
          },
        ],
      },
      center: [-0.1276, 51.5074], // London center
      zoom: 11,
      minZoom: 9,
      maxZoom: 16,
    });

    map.current.on('load', () => {
      const mapInstance = map.current;
      if (!mapInstance) return;

      // Filter data to only Underground
      const undergroundLines = filterUndergroundLines(linesData as FeatureCollection);
      const undergroundStations = filterUndergroundStations(stationsData as FeatureCollection);

      // Add tube lines source
      mapInstance.addSource('tube-lines', {
        type: 'geojson',
        data: undergroundLines,
      });

      // Add tube lines casing (outline) for visibility on dark background
      mapInstance.addLayer({
        id: 'tube-lines-casing',
        type: 'line',
        source: 'tube-lines',
        paint: {
          'line-color': '#ffffff',
          'line-width': 5,
          'line-opacity': 0.3,
        },
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
        },
      });

      // Add tube lines layer - render each line with its color
      mapInstance.addLayer({
        id: 'tube-lines-layer',
        type: 'line',
        source: 'tube-lines',
        paint: {
          'line-color': [
            'match',
            ['get', 'lineName'],
            'Bakerloo', '#B36305',
            'Central', '#E32017',
            'Circle', '#FFD300',
            'District', '#00782A',
            'Hammersmith & City', '#F3A9BB',
            'Jubilee', '#A0A5A9',
            'Metropolitan', '#9B0056',
            'Northern', '#1a1a1a', // Slightly lighter than pure black
            'Piccadilly', '#003688',
            'Victoria', '#0098D4',
            'Waterloo & City', '#95CDBA',
            '#888888', // default
          ],
          'line-width': 3,
          'line-opacity': 1,
        },
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
        },
      });

      // Add stations source
      mapInstance.addSource('tube-stations', {
        type: 'geojson',
        data: undergroundStations,
      });

      // Add stations layer
      mapInstance.addLayer({
        id: 'tube-stations-layer',
        type: 'circle',
        source: 'tube-stations',
        paint: {
          'circle-radius': [
            'interpolate',
            ['linear'],
            ['zoom'],
            10, 2,
            14, 5,
          ],
          'circle-color': '#ffffff',
          'circle-stroke-color': '#333333',
          'circle-stroke-width': 1,
        },
      });

      // Add station labels at higher zoom
      mapInstance.addLayer({
        id: 'tube-stations-labels',
        type: 'symbol',
        source: 'tube-stations',
        minzoom: 13,
        layout: {
          'text-field': ['get', 'name'],
          'text-size': 11,
          'text-offset': [0, 1.5],
          'text-anchor': 'top',
          'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
        },
        paint: {
          'text-color': '#ffffff',
          'text-halo-color': '#000000',
          'text-halo-width': 1,
        },
      });
    });

    // Cleanup
    return () => {
      map.current?.remove();
      map.current = null;
    };
  }, []);

  return (
    <div ref={mapContainer} className="w-full h-full" />
  );
}
