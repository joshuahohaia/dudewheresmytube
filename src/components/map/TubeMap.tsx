import { useEffect, useRef, useCallback, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { isUndergroundLine, LINE_COLORS } from '../../lib/lineColors';
import { useTrains } from '../../hooks/useTrains';
import { useTrainPositions } from '../../hooks/useTrainPositions';
import linesData from '../../data/tfl_lines.json';
import stationsData from '../../data/tfl_stations.json';
import type { FeatureCollection, Feature, LineString, Point } from 'geojson';
import type { TrainWithPosition } from '../../types/train';

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

// Convert trains to GeoJSON for MapLibre
function trainsToGeoJSON(trains: TrainWithPosition[]): FeatureCollection<Point> {
  return {
    type: 'FeatureCollection',
    features: trains.map((train) => ({
      type: 'Feature' as const,
      properties: {
        id: train.id,
        lineId: train.lineId,
        lineName: train.lineName,
        destination: train.destination,
        timeToStation: train.timeToStation,
        heading: train.heading,
        color: LINE_COLORS[train.lineName] || '#888888',
      },
      geometry: {
        type: 'Point' as const,
        coordinates: train.position,
      },
    })),
  };
}

// Convert trails to GeoJSON
function trailsToGeoJSON(
  trails: Array<{ id: string; lineId: string; lineName: string; coordinates: [number, number][] }>
): FeatureCollection<LineString> {
  return {
    type: 'FeatureCollection',
    features: trails.map((trail) => ({
      type: 'Feature' as const,
      properties: {
        id: trail.id,
        color: LINE_COLORS[trail.lineName] || '#888888',
      },
      geometry: {
        type: 'LineString' as const,
        coordinates: trail.coordinates,
      },
    })),
  };
}

export function TubeMap() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const mapLoaded = useRef(false);

  const { data: trainsData, isLoading, error, dataUpdatedAt, isFetching } = useTrains();
  const { positions, getTrails } = useTrainPositions(trainsData?.trains);

  // Countdown timer state
  const [timeInfo, setTimeInfo] = useState({ sinceLast: 0, untilNext: 15 });
  const REFETCH_INTERVAL = 15; // seconds

  useEffect(() => {
    const updateTimer = () => {
      if (dataUpdatedAt) {
        const sinceLast = Math.floor((Date.now() - dataUpdatedAt) / 1000);
        const untilNext = Math.max(0, REFETCH_INTERVAL - sinceLast);
        setTimeInfo({ sinceLast, untilNext });
      }
    };

    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  }, [dataUpdatedAt]);

  // Update map sources
  const updateSources = useCallback(() => {
    if (!map.current || !mapLoaded.current) return;

    const mapInstance = map.current;

    // Update trains
    const trainsSource = mapInstance.getSource('trains') as maplibregl.GeoJSONSource;
    if (trainsSource && positions.length > 0) {
      trainsSource.setData(trainsToGeoJSON(positions));
    }

    // Update trails
    const trailsSource = mapInstance.getSource('trails') as maplibregl.GeoJSONSource;
    if (trailsSource) {
      const trails = getTrails();
      trailsSource.setData(trailsToGeoJSON(trails));
    }
  }, [positions, getTrails]);

  // Update sources on each animation frame
  useEffect(() => {
    updateSources();
  }, [updateSources]);

  // Initialize map
  useEffect(() => {
    if (map.current || !mapContainer.current) return;

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
      center: [-0.1276, 51.5074],
      zoom: 11,
      minZoom: 9,
      maxZoom: 16,
    });

    map.current.on('load', () => {
      const mapInstance = map.current;
      if (!mapInstance) return;

      mapLoaded.current = true;

      const undergroundLines = filterUndergroundLines(linesData as FeatureCollection);
      const undergroundStations = filterUndergroundStations(stationsData as FeatureCollection);

      // Add tube lines source
      mapInstance.addSource('tube-lines', {
        type: 'geojson',
        data: undergroundLines,
      });

      // Add tube lines casing
      mapInstance.addLayer({
        id: 'tube-lines-casing',
        type: 'line',
        source: 'tube-lines',
        paint: {
          'line-color': '#ffffff',
          'line-width': 6,
          'line-opacity': 0.2,
        },
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
        },
      });

      // Add tube lines layer with offset for parallel lines
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
            'Northern', '#1a1a1a',
            'Piccadilly', '#003688',
            'Victoria', '#0098D4',
            'Waterloo & City', '#95CDBA',
            '#888888',
          ],
          'line-width': 3,
          'line-opacity': 1,
          // Offset parallel lines so they don't overlap
          'line-offset': [
            'match',
            ['get', 'lineName'],
            'Circle', 3,
            'Hammersmith & City', -3,
            'District', 0,
            'Metropolitan', 3,
            0,
          ],
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

      // Add station labels
      mapInstance.addLayer({
        id: 'tube-stations-labels',
        type: 'symbol',
        source: 'tube-stations',
        minzoom: 12,
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

      // Add trails source
      mapInstance.addSource('trails', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      // Add trails layer (subtle fading line behind trains)
      mapInstance.addLayer({
        id: 'trails-layer',
        type: 'line',
        source: 'trails',
        paint: {
          'line-color': ['get', 'color'],
          'line-width': 2,
          'line-opacity': 0.3,
        },
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
        },
      });

      // Add trains source
      mapInstance.addSource('trains', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      // Add train glow layer (subtle halo effect)
      mapInstance.addLayer({
        id: 'trains-glow',
        type: 'circle',
        source: 'trains',
        paint: {
          'circle-radius': [
            'interpolate',
            ['linear'],
            ['zoom'],
            10, 8,
            14, 14,
          ],
          'circle-color': ['get', 'color'],
          'circle-opacity': 0.3,
          'circle-blur': 1,
        },
      });

      // Add trains layer - solid dot with white outline for visibility
      mapInstance.addLayer({
        id: 'trains-layer',
        type: 'circle',
        source: 'trains',
        paint: {
          'circle-radius': [
            'interpolate',
            ['linear'],
            ['zoom'],
            10, 5,
            14, 9,
          ],
          'circle-color': ['get', 'color'],
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 1.5,
          'circle-stroke-opacity': 0.8,
        },
      });

      // Add popup on train click
      mapInstance.on('click', 'trains-layer', (e) => {
        if (!e.features || e.features.length === 0) return;

        const feature = e.features[0];
        const props = feature.properties;
        const coordinates = (feature.geometry as Point).coordinates.slice() as [number, number];

        new maplibregl.Popup({ closeButton: false, className: 'train-popup' })
          .setLngLat(coordinates)
          .setHTML(`
            <div style="font-family: system-ui, sans-serif; padding: 2px;">
              <div style="font-weight: 600; color: ${props?.color}; border-bottom: 2px solid ${props?.color}; padding-bottom: 4px; margin-bottom: 4px;">
                ${props?.lineName} Line
              </div>
              <div style="color: #333; font-size: 13px;">
                <div>→ ${props?.destination}</div>
                <div style="color: #666; font-size: 11px; margin-top: 2px;">
                  ${props?.timeToStation}s to next station
                </div>
              </div>
            </div>
          `)
          .addTo(mapInstance);
      });

      // Change cursor on hover
      mapInstance.on('mouseenter', 'trains-layer', () => {
        if (mapInstance) mapInstance.getCanvas().style.cursor = 'pointer';
      });

      mapInstance.on('mouseleave', 'trains-layer', () => {
        if (mapInstance) mapInstance.getCanvas().style.cursor = '';
      });
    });

    return () => {
      map.current?.remove();
      map.current = null;
      mapLoaded.current = false;
    };
  }, []);

  return (
    <div className="relative w-full h-full">
      <div ref={mapContainer} className="w-full h-full" />

      {/* Title + Status overlay - left */}
      <div className="absolute top-4 left-4 flex flex-col gap-2">
        <div className="bg-black/80 text-white px-4 py-2 rounded">
          <h1 className="text-lg font-bold tracking-tight">DudeWheresMyTube</h1>
          <p className="text-xs text-gray-400">Live London Underground Tracker</p>
        </div>
        <div className="bg-black/70 text-white px-3 py-2 rounded text-sm">
          {isLoading && !positions.length && <span>Loading trains...</span>}
          {error && <span className="text-red-400">Error: {error.message}</span>}
          {positions.length > 0 && (
            <span className="flex items-center gap-2">
              <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
              {positions.length} trains live
            </span>
          )}
        </div>
      </div>

      {/* Timer badge - right */}
      <div className="absolute top-4 right-4 bg-black/70 text-white px-3 py-2 rounded text-sm font-mono">
        <div className="flex items-center gap-3">
          <div className="text-center">
            <div className="text-xs text-gray-400">Last update</div>
            <div className={isFetching ? 'text-yellow-400' : ''}>
              {isFetching ? 'fetching...' : `${timeInfo.sinceLast}s ago`}
            </div>
          </div>
          <div className="w-px h-8 bg-gray-600" />
          <div className="text-center">
            <div className="text-xs text-gray-400">Next in</div>
            <div className={timeInfo.untilNext <= 3 ? 'text-green-400' : ''}>
              {timeInfo.untilNext}s
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
