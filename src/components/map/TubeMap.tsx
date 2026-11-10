import { useEffect, useRef, useCallback, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { isUndergroundLine, LINE_COLORS } from '../../lib/lineColors';
import { useTrains } from '../../hooks/useTrains';
import { useTrainPositions } from '../../hooks/useTrainPositions';
import { compassDirection, formatCountdown, formatSpeed, estimateSpeed } from '../../lib/followFormat';
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
        target: train.estimatedTarget || train.currentStation,
        predictionStale: !!train.predictionStale,
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
  const { positions, getTrails } = useTrainPositions(trainsData?.trains, dataUpdatedAt);

  // Countdown timer state
  const [timeInfo, setTimeInfo] = useState({ sinceLast: 0, untilNext: 10 });

  // Quiet stale-data indicator: a small dot instead of a persistent banner.
  // Details open on tap and can be dismissed; per-train popups still say when
  // a specific estimate is held on older feed data.
  const [staleNoteDismissed, setStaleNoteDismissed] = useState(() => {
    try {
      return localStorage.getItem('dwmt-stale-note-dismissed') === '1';
    } catch {
      return false;
    }
  });
  const [staleInfoOpen, setStaleInfoOpen] = useState(false);

  // Follow-a-train state
  const [followedId, setFollowedId] = useState<string | null>(null);
  const [followSpeed, setFollowSpeed] = useState<number | null>(null);
  const followMarker = useRef<maplibregl.Marker | null>(null);
  const speedSamples = useRef<Array<[number, number, number]>>([]);
  const REFETCH_INTERVAL = 10; // seconds

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
    if (trainsSource) {
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
    
      style: 'https://basemaps.cartocdn.com/gl/dark-matter-nolabels-gl-style/style.json',
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

      // Click a train to follow it: pulsing ring, camera tracking, detail panel.
      mapInstance.on('click', 'trains-layer', (e) => {
        if (!e.features || e.features.length === 0) return;
        const id = e.features[0].properties?.id as string | undefined;
        if (id) setFollowedId((current) => (current === id ? null : id));
      });

      // Grabbing or zooming the map releases the follow camera.
      mapInstance.on('dragstart', () => setFollowedId(null));
      mapInstance.on('wheel', () => setFollowedId(null));

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

  // Follow mode: select animation, camera tracking and speed sampling.
  // Runs on every position frame; setCenter on a smoothly moving train keeps
  // the ride fluid rather than jumpy.
  const followedTrain = followedId ? positions.find((p) => p.id === followedId) : undefined;

  useEffect(() => {
    const mapInstance = map.current;
    if (!mapInstance || !mapLoaded.current) return;

    if (!followedId) {
      followMarker.current?.remove();
      followMarker.current = null;
      speedSamples.current = [];
      setFollowSpeed(null);
      return;
    }

    const train = positions.find((p) => p.id === followedId);
    if (!train) return;

    if (!followMarker.current) {
      const el = document.createElement('div');
      el.className = 'follow-ring';
      followMarker.current = new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat(train.position)
        .addTo(mapInstance);
      // Selection animation: ease in and tighten the zoom on the train.
      mapInstance.easeTo({
        center: train.position,
        zoom: Math.max(mapInstance.getZoom(), 13),
        duration: 900,
      });
    }

    followMarker.current.getElement().style.borderColor = LINE_COLORS[train.lineName] || '#ffffff';
    followMarker.current.setLngLat(train.position);
    mapInstance.setCenter(train.position);

    const now = Date.now();
    const samples = speedSamples.current;
    samples.push([now, train.position[0], train.position[1]]);
    while (samples.length > 40) samples.shift();
    setFollowSpeed(estimateSpeed(samples));
  }, [positions, followedId]);

  return (
    <div className="relative w-full h-full">
      <div ref={mapContainer} className="w-full h-full" />

      {/* Title + Status overlay - left */}
      <div className="absolute top-4 left-4 flex flex-col gap-2">
        <div className="bg-black/80 text-white px-4 py-2 rounded">
          <h1 className="text-lg font-bold tracking-tight">Dude Wheres My Tube?</h1>
          <p className="text-xs text-gray-400">Live London Underground Tracker</p>
        </div>
        <div className="bg-black/70 text-white px-3 py-2 rounded text-sm">
          {isLoading && !positions.length && <span>Loading trains...</span>}
          {error && <span className="text-red-400">Error: {error.message}</span>}
          {trainsData?.failedLines?.length ? <span className="block text-amber-300 text-xs">TfL feed unavailable for {trainsData.failedLines.length} lines</span> : null}
          {positions.some(p => p.predictionStale) && !staleNoteDismissed && (
            <span className="flex items-center gap-1.5 text-xs">
              <button
                type="button"
                onClick={() => setStaleInfoOpen((open) => !open)}
                className="w-2 h-2 rounded-full bg-amber-300/80 hover:bg-amber-200 shrink-0"
                aria-label="Some estimates are stale - tap for details"
                title="Some estimates are held on older feed data"
              />
              {staleInfoOpen && (
                <span className="text-amber-200/90 text-[11px]">
                  Some estimates are held on older feed data.
                  <button
                    type="button"
                    className="ml-1 underline hover:text-amber-100"
                    onClick={() => {
                      try {
                        localStorage.setItem('dwmt-stale-note-dismissed', '1');
                      } catch {
                        // private mode etc - dismissal just won't persist
                      }
                      setStaleNoteDismissed(true);
                    }}
                  >
                    Don't show again
                  </button>
                </span>
              )}
            </span>
          )}
          {positions.length > 0 && (
            <>
              <span className="flex items-center gap-2">
                <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
                {positions.length} trains {error ? '(last known)' : 'live'}
              </span>
              <span className="block text-[11px] text-gray-400 mt-1">
                Movement and station departures are estimates
              </span>
            </>
          )}
        </div>
      </div>

      {/* Followed-train detail panel */}
      {followedId && (
        <div className="absolute bottom-4 left-4 right-4 sm:right-auto sm:min-w-80 sm:max-w-sm bg-black/85 text-white rounded-lg p-3 shadow-lg border border-white/10">
          {followedTrain ? (
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    className="inline-block w-3 h-3 rounded-full shrink-0"
                    style={{ backgroundColor: LINE_COLORS[followedTrain.lineName] || '#888888' }}
                  />
                  <span className="font-semibold">{followedTrain.lineName} Line</span>
                  <span className="text-gray-400 text-sm truncate">→ {followedTrain.destination}</span>
                </div>
                <div className="mt-1 text-sm">
                  {followedTrain.predictionStale ? (
                    <span className="text-amber-300">Estimate held - feed data is stale</span>
                  ) : (
                    <span>
                      Next: {followedTrain.estimatedTarget || followedTrain.currentStation} in{' '}
                      {formatCountdown(followedTrain.timeToStation)} (est.)
                    </span>
                  )}
                </div>
                <div className="mt-1 text-xs text-gray-400 flex gap-3 flex-wrap">
                  {followSpeed !== null && <span>{formatSpeed(followSpeed)} est.</span>}
                  <span>heading {compassDirection(followedTrain.heading)}</span>
                  <span className="text-gray-500">positions are estimates</span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setFollowedId(null)}
                aria-label="Stop following"
                className="text-gray-400 hover:text-white text-xl leading-none px-1"
              >
                ×
              </button>
            </div>
          ) : (
            <div className="flex items-start justify-between gap-3">
              <div className="text-sm text-gray-300">This train has left the live feed.</div>
              <button
                type="button"
                onClick={() => setFollowedId(null)}
                aria-label="Close"
                className="text-gray-400 hover:text-white text-xl leading-none px-1"
              >
                ×
              </button>
            </div>
          )}
          {followedTrain && (
            <div className="mt-1 text-[11px] text-gray-500">Following - drag or scroll the map to release</div>
          )}
        </div>
      )}

      {/* Timer badge - desktop/tablet only; keep mobile map uncluttered. */}
      <div className="hidden sm:block absolute top-4 right-4 bg-black/70 text-white px-3 py-2 rounded text-sm font-mono">
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
