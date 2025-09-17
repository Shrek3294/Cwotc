import { useState, useEffect, useMemo, useCallback } from 'react';
import DeckGL from '@deck.gl/react';
import { ScatterplotLayer } from '@deck.gl/layers';
import { HeatmapLayer } from '@deck.gl/aggregation-layers';
import { Map } from 'react-map-gl';
import { useDebounce } from './hooks/useDebounce.js';

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');

function apiFetch(path, options) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const url = API_BASE_URL ? `${API_BASE_URL}${normalizedPath}` : normalizedPath;
  return fetch(url, options);
}

const MAP_STYLES = {
  Dark: 'mapbox://styles/mapbox/dark-v11',
  Light: 'mapbox://styles/mapbox/light-v11',
  Streets: 'mapbox://styles/mapbox/streets-v12',
  Satellite: 'mapbox://styles/mapbox/satellite-streets-v12',
};

const currency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

const numberFormatter = new Intl.NumberFormat('en-US');

function formatCurrency(value) {
  if (value == null || Number.isNaN(value)) return '—';
  return currency.format(Number(value));
}

function formatNumber(value) {
  if (value == null || Number.isNaN(value)) return '—';
  return numberFormatter.format(Number(value));
}

function formatDate(value) {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString();
  } catch (err) {
    return value;
  }
}

function buildCsv(items) {
  if (!items?.length) return '';
  const columns = [
    'addressClean',
    'cityStateZip',
    'county',
    'price',
    'priceNum',
    'beds',
    'baths',
    'sqft',
    'saleWindow',
    'propertyType',
    'lotSizeAcres',
    'yearBuilt',
    'estResaleValue',
    'url',
    'addendumUrl',
    'isCwcot',
    'hasAddendum',
    'firstSeen',
    'lastSeen',
    'status',
  ];
  const header = columns.join(',');
  const rows = items.map(item =>
    columns
      .map(key => {
        const value = item[key] ?? '';
        const normalized = typeof value === 'string' ? value : String(value ?? '');
        return `"${normalized.replace(/"/g, '""')}"`;
      })
      .join(','),
  );
  return [header, ...rows].join('\n');
}

export default function App() {
  const [config, setConfig] = useState(null);
  const [stats, setStats] = useState(null);
  const [properties, setProperties] = useState([]);
  const [meta, setMeta] = useState({ total: 0, count: 0 });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [geocodeSummary, setGeocodeSummary] = useState(null);
  const [geocodeRunning, setGeocodeRunning] = useState(false);
  const [view, setView] = useState('table');
  const [selected, setSelected] = useState(null);
  const [mapInitialized, setMapInitialized] = useState(false);
  const [viewState, setViewState] = useState({
    latitude: 40.73,
    longitude: -73.94,
    zoom: 5.2,
    pitch: 45,
    bearing: 0,
  });
  const [filters, setFilters] = useState({
    status: 'active',
    maxPrice: '',
    onlyCwcot: false,
    hasAddendum: false,
    search: '',
    mapStyle: 'Dark',
    showHeatmap: true,
    markerRadius: 800,
    markerMinPx: 6,
    markerMaxPx: 24,
  });
  const [appliedDefaultMax, setAppliedDefaultMax] = useState(false);

  const debouncedSearch = useDebounce(filters.search, 350);

  useEffect(() => {
    async function bootstrap() {
      try {
        const [configRes, statsRes, geoRes] = await Promise.all([
          apiFetch('/api/config'),
          apiFetch('/api/stats'),
          apiFetch('/api/geocode/summary'),
        ]);
        if (!configRes.ok) throw new Error('Failed to load config');
        if (!statsRes.ok) throw new Error('Failed to load stats');
        if (!geoRes.ok) throw new Error('Failed to load geocode summary');
        const [configJson, statsJson, geoJson] = await Promise.all([
          configRes.json(),
          statsRes.json(),
          geoRes.json(),
        ]);
        setConfig(configJson);
        setStats(statsJson);
        setGeocodeSummary(geoJson);
        if (!appliedDefaultMax && statsJson?.priceMax) {
          const normalized = Math.ceil(Number(statsJson.priceMax) / 1000) * 1000;
          setFilters(prev => ({ ...prev, maxPrice: normalized }));
          setAppliedDefaultMax(true);
        }
      } catch (err) {
        setError(err.message || 'Failed to initialise application');
      }
    }
    bootstrap();
  }, [appliedDefaultMax]);

  const refreshStats = useCallback(async () => {
    try {
      const res = await apiFetch('/api/stats');
      if (res.ok) {
        const json = await res.json();
        setStats(json);
      }
    } catch (err) {
      console.warn('Failed to refresh stats', err);
    }
  }, []);

  const refreshGeocodeSummary = useCallback(async () => {
    try {
      const res = await apiFetch('/api/geocode/summary');
      if (res.ok) {
        const json = await res.json();
        setGeocodeSummary(json);
      }
    } catch (err) {
      console.warn('Failed to refresh geocode summary', err);
    }
  }, []);

  const loadProperties = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      params.set('status', filters.status);
      if (filters.maxPrice) params.set('maxPrice', String(filters.maxPrice));
      if (filters.onlyCwcot) params.set('onlyCwcot', '1');
      if (filters.hasAddendum) params.set('hasAddendum', '1');
      if (debouncedSearch) params.set('search', debouncedSearch);
      const res = await apiFetch(`/api/properties?${params.toString()}`);
      if (!res.ok) throw new Error(`Failed to load properties (${res.status})`);
      const json = await res.json();
      setProperties(Array.isArray(json.items) ? json.items : []);
      setMeta({ total: json.total ?? 0, count: json.count ?? 0 });
    } catch (err) {
      setError(err.message || 'Failed to load properties');
    } finally {
      setLoading(false);
    }
  }, [filters.status, filters.maxPrice, filters.onlyCwcot, filters.hasAddendum, debouncedSearch]);

  useEffect(() => {
    loadProperties();
  }, [loadProperties]);

  useEffect(() => {
    setMapInitialized(false);
  }, [filters.status, filters.maxPrice, filters.onlyCwcot, filters.hasAddendum, debouncedSearch]);

  useEffect(() => {
    if (!selected) return;
    const stillExists = properties.find(item => item.id === selected.id);
    if (!stillExists) {
      setSelected(null);
    }
  }, [properties, selected]);

  const mapData = useMemo(() => {
    return properties
      .filter(item => Number.isFinite(item.lat) && Number.isFinite(item.lng))
      .map(item => ({
        ...item,
        position: [Number(item.lng), Number(item.lat)],
        fillColor: item.isCwcot ? [102, 227, 164, 220] : [122, 162, 255, 220],
      }));
  }, [properties]);

  const mapCenter = useMemo(() => {
    if (!mapData.length) return { latitude: viewState.latitude, longitude: viewState.longitude };
    const totals = mapData.reduce(
      (acc, item) => {
        acc.lat += Number(item.lat);
        acc.lng += Number(item.lng);
        return acc;
      },
      { lat: 0, lng: 0 },
    );
    return {
      latitude: totals.lat / mapData.length,
      longitude: totals.lng / mapData.length,
    };
  }, [mapData, viewState.latitude, viewState.longitude]);

  useEffect(() => {
    if (mapData.length && !mapInitialized) {
      setViewState(prev => ({
        ...prev,
        latitude: mapCenter.latitude,
        longitude: mapCenter.longitude,
        zoom: Math.min(Math.max(prev.zoom, 5), 9),
      }));
      setMapInitialized(true);
    }
  }, [mapData, mapInitialized, mapCenter.latitude, mapCenter.longitude]);

  const layers = useMemo(() => {
    const scatter = new ScatterplotLayer({
      id: 'properties-scatter',
      data: mapData,
      pickable: true,
      getPosition: d => d.position,
      getFillColor: d => d.fillColor,
      getRadius: Number(filters.markerRadius) || 800,
      radiusUnits: 'meters',
      radiusMinPixels: Number(filters.markerMinPx) || 6,
      radiusMaxPixels: Number(filters.markerMaxPx) || 24,
      stroked: true,
      getLineColor: [255, 255, 255],
      getLineWidth: 2,
    });
    const heatmap = filters.showHeatmap
      ? new HeatmapLayer({
          id: 'properties-heat',
          data: mapData,
          getPosition: d => d.position,
          getWeight: d => Number(d.priceNum) || 1,
          radiusPixels: 50,
          intensity: 1,
          threshold: 0.02,
        })
      : null;
    return heatmap ? [heatmap, scatter] : [scatter];
  }, [mapData, filters.markerRadius, filters.markerMinPx, filters.markerMaxPx, filters.showHeatmap]);

  const tooltip = useCallback(info => {
    if (!info?.object) return null;
    const item = info.object;
    const price = item.price || formatCurrency(item.priceNum);
    return {
      html: `
        <div style="font-family: system-ui, sans-serif; padding: 12px; min-width: 220px;">
          <h3 style="margin:0 0 6px; font-size: 1rem;">${item.addressClean || item.address || 'Unknown'}</h3>
          <p style="margin:0; font-size:0.9rem;"><strong>Price:</strong> ${price}</p>
          <p style="margin:4px 0 0; font-size:0.9rem;"><strong>Beds/Baths:</strong> ${item.beds ?? '—'} / ${item.baths ?? '—'}</p>
          <p style="margin:4px 0 0; font-size:0.9rem;"><strong>Type:</strong> ${item.propertyType ?? '—'}</p>
          <p style="margin:4px 0 0; font-size:0.9rem;">${item.saleWindow ?? ''}</p>
          <div style="margin-top:8px; display:flex; gap:8px;">
            <a style="color:#38bdf8; text-decoration:none; font-weight:600;" href="${item.url}" target="_blank" rel="noreferrer">Open listing</a>
            ${item.addendumUrl ? `<a style="color:#bbf7d0; text-decoration:none; font-weight:600;" href="${item.addendumUrl}" target="_blank" rel="noreferrer">Addendum</a>` : ''}
          </div>
        </div>
      `,
      style: {
        backgroundColor: 'rgba(15,23,42,0.92)',
        color: 'white',
        borderRadius: '8px',
        boxShadow: '0 12px 28px rgba(15,23,42,0.45)',
        pointerEvents: 'auto',
      },
    };
  }, []);

  const handleDownload = () => {
    const csv = buildCsv(properties);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', 'auction_properties.csv');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleGeocode = async () => {
    setGeocodeRunning(true);
    try {
      const res = await apiFetch('/api/geocode/missing', { method: 'POST' });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || 'Geocode failed');
      }
      await refreshGeocodeSummary();
      await loadProperties();
      await refreshStats();
    } catch (err) {
      setError(err.message || 'Geocode failed');
    } finally {
      setGeocodeRunning(false);
    }
  };

  const handleClearGeocode = async () => {
    try {
      await apiFetch('/api/geocode/cache', { method: 'DELETE' });
      await refreshGeocodeSummary();
    } catch (err) {
      setError(err.message || 'Failed to clear geocode cache');
    }
  };

  const updateFilter = (key, value) => {
    setFilters(prev => ({ ...prev, [key]: value }));
    if (key !== 'search') {
      setSelected(null);
    }
  };

  const quickStats = [
    { label: 'Active', value: stats?.active },
    { label: 'CWCOT', value: stats?.cwcot },
    { label: 'With addendum', value: stats?.withAddendum },
  ];

  return (
    <div className="app-grid">
      <aside className="filters-panel">
        <div className="panel-section">
          <h1>Auction Property Explorer</h1>
          <span className="subtext">
            {meta.count ? `Viewing ${meta.count} of ${meta.total} tracked properties` : 'Loading inventory…'}
          </span>
        </div>

        <div className="panel-section">
          <label>
            <span className="panel-label">Status</span>
            <select value={filters.status} onChange={e => updateFilter('status', e.target.value)}>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
              <option value="all">All</option>
            </select>
          </label>

          <label>
            <span className="panel-label">Max price</span>
            <input
              type="range"
              min={stats?.priceMin ? Math.max(0, Math.floor(stats.priceMin)) : 0}
              max={stats?.priceMax ? Math.ceil(stats.priceMax) : 5000000}
              step={1000}
              value={Number(filters.maxPrice) || 0}
              onChange={e => updateFilter('maxPrice', Number(e.target.value))}
            />
            <span className="subtext">{filters.maxPrice ? formatCurrency(filters.maxPrice) : 'No maximum filter'}</span>
          </label>

          <label className="toggle">
            <input
              type="checkbox"
              checked={filters.onlyCwcot}
              onChange={e => updateFilter('onlyCwcot', e.target.checked)}
            />
            <span>Only CWCOT</span>
          </label>

          <label className="toggle">
            <input
              type="checkbox"
              checked={filters.hasAddendum}
              onChange={e => updateFilter('hasAddendum', e.target.checked)}
            />
            <span>Has addendum</span>
          </label>

          <label>
            <span className="panel-label">Search</span>
            <input
              type="text"
              placeholder="City, county, zip…"
              value={filters.search}
              onChange={e => updateFilter('search', e.target.value)}
            />
          </label>
        </div>

        <div className="panel-section">
          <h2>Geocoding</h2>
          <span className="subtext">
            Cache {geocodeSummary?.cache?.total ?? 0} • Missing {geocodeSummary?.propertiesMissingCoords ?? 0}
          </span>
          <button onClick={handleGeocode} disabled={geocodeRunning || !geocodeSummary?.mapboxToken}>
            {geocodeRunning ? 'Geocoding…' : 'Geocode missing'}
          </button>
          <button onClick={handleClearGeocode} disabled={geocodeRunning} className="secondary">
            Clear cache
          </button>
          {!geocodeSummary?.mapboxToken && (
            <span className="subtext">Add MAPBOX_TOKEN to enable live mapping.</span>
          )}
        </div>
      </aside>

      <div className="workspace">
        <header className="top-bar">
          <div>
            <h2>Portfolio overview</h2>
            <p className="subtext">Last ingest: {formatDate(stats?.latestRun)}</p>
          </div>
          <div className="top-bar-metrics">
            {quickStats.map(stat => (
              <div key={stat.label} className="metric-chip">
                <span>{stat.label}</span>
                <strong>{formatNumber(stat.value)}</strong>
              </div>
            ))}
            {loading && <span className="loading">Refreshing…</span>}
          </div>
        </header>

        {error && <div className="error banner">{error}</div>}

        <div className="workspace-grid">
          <section className="map-panel">
            <div className="map-toolbar">
              <label>
                <span className="panel-label">Basemap</span>
                <select value={filters.mapStyle} onChange={e => updateFilter('mapStyle', e.target.value)}>
                  {Object.keys(MAP_STYLES).map(key => (
                    <option key={key} value={key}>
                      {key}
                    </option>
                  ))}
                </select>
              </label>
              <label className="toggle compact">
                <input
                  type="checkbox"
                  checked={filters.showHeatmap}
                  onChange={e => updateFilter('showHeatmap', e.target.checked)}
                />
                <span>Heatmap</span>
              </label>
              <div className="marker-range">
                <span className="panel-label">Radius</span>
                <input
                  type="range"
                  min={100}
                  max={3000}
                  step={50}
                  value={Number(filters.markerRadius) || 0}
                  onChange={e => updateFilter('markerRadius', Number(e.target.value))}
                />
                <span className="subtext">{filters.markerRadius} m</span>
              </div>
              <div className="marker-pixels">
                <span className="panel-label">Marker px</span>
                <div className="controls-inline">
                  <input
                    type="number"
                    min={1}
                    max={30}
                    value={filters.markerMinPx}
                    onChange={e => updateFilter('markerMinPx', Number(e.target.value))}
                  />
                  <span>to</span>
                  <input
                    type="number"
                    min={5}
                    max={60}
                    value={filters.markerMaxPx}
                    onChange={e => updateFilter('markerMaxPx', Number(e.target.value))}
                  />
                </div>
              </div>
            </div>

            <div className="map-wrapper">
              {config?.mapboxToken ? (
                <DeckGL
                  layers={layers}
                  controller
                  getTooltip={tooltip}
                  onClick={info => info.object && setSelected(info.object)}
                  viewState={viewState}
                  onViewStateChange={({ viewState: vs }) => setViewState(vs)}
                  style={{ position: 'absolute', inset: 0 }}
                >
                  <Map mapStyle={MAP_STYLES[filters.mapStyle]} mapboxAccessToken={config?.mapboxToken} reuseMaps />
                </DeckGL>
              ) : (
                <div className="map-placeholder">
                  <p>Set a MAPBOX_TOKEN to render the live map.</p>
                </div>
              )}
            </div>

            {selected && (
              <div className="selected-card">
                <h3>{selected.addressClean || selected.address || 'Selected property'}</h3>
                <span className="subtext">{selected.cityStateZip}</span>
                <span className="subtext">{selected.saleWindow}</span>
                <div className="controls-inline">
                  {selected.isCwcot && <span className="badge cwcot">CWCOT</span>}
                  {selected.hasAddendum && <span className="badge addendum">Addendum</span>}
                  {selected.changeCount ? <span className="badge">{selected.changeCount} updates</span> : null}
                </div>
                <p>
                  <strong>Price:</strong> {selected.price || formatCurrency(selected.priceNum)} • <strong>Beds:</strong>{' '}
                  {selected.beds ?? '—'} • <strong>Baths:</strong> {selected.baths ?? '—'} • <strong>Sqft:</strong>{' '}
                  {selected.sqftNum ? formatNumber(selected.sqftNum) : selected.sqft || '—'}
                </p>
                <div className="actions">
                  <a href={selected.url} target="_blank" rel="noreferrer">
                    Open listing
                  </a>
                  {selected.addendumUrl && (
                    <a href={selected.addendumUrl} target="_blank" rel="noreferrer">
                      View addendum
                    </a>
                  )}
                </div>
              </div>
            )}
          </section>

          <section className="insights-panel">
            <div className="panel-header">
              <div className="view-tabs">
                {['table', 'stats'].map(tab => (
                  <button
                    key={tab}
                    className={view === tab ? 'active' : ''}
                    onClick={() => setView(tab)}
                  >
                    {tab === 'table' ? 'Table' : 'Stats'}
                  </button>
                ))}
              </div>
              <button className="download-btn" onClick={handleDownload} disabled={!properties.length}>
                Download CSV
              </button>
            </div>

            <div className="panel-body">
              {view === 'table' ? (
                <div className="table-wrapper">
                  <table>
                    <thead>
                      <tr>
                        <th>Address</th>
                        <th>Price</th>
                        <th>Beds</th>
                        <th>Baths</th>
                        <th>Sqft</th>
                        <th>Sale window</th>
                        <th>Type</th>
                        <th>Links</th>
                      </tr>
                    </thead>
                    <tbody>
                      {properties.map(item => (
                        <tr
                          key={item.id}
                          className={selected?.id === item.id ? 'selected-row' : ''}
                          onClick={() => setSelected(item)}
                        >
                          <td>
                            <div>
                              <strong>{item.addressClean || item.address}</strong>
                              <div className="subtext">{item.cityStateZip}</div>
                              <div className="controls-inline">
                                {item.isCwcot && <span className="badge cwcot">CWCOT</span>}
                                {item.hasAddendum && <span className="badge addendum">Addendum</span>}
                                {item.changeCount ? <span className="badge">{item.changeCount} updates</span> : null}
                              </div>
                            </div>
                          </td>
                          <td>{item.price || formatCurrency(item.priceNum)}</td>
                          <td>{item.beds ?? '—'}</td>
                          <td>{item.baths ?? '—'}</td>
                          <td>{item.sqftNum ? formatNumber(item.sqftNum) : item.sqft || '—'}</td>
                          <td>{item.saleWindow || '—'}</td>
                          <td>{item.propertyType || '—'}</td>
                          <td>
                            <a href={item.url} target="_blank" rel="noreferrer">
                              Listing
                            </a>
                            {item.addendumUrl ? (
                              <>
                                {' '}•{' '}
                                <a href={item.addendumUrl} target="_blank" rel="noreferrer">
                                  Addendum
                                </a>
                              </>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="stats-grid">
                  <div className="stat-card">
                    <h3>Total records</h3>
                    <p>{formatNumber(stats?.total)}</p>
                  </div>
                  <div className="stat-card">
                    <h3>Active</h3>
                    <p>{formatNumber(stats?.active)}</p>
                  </div>
                  <div className="stat-card">
                    <h3>Inactive</h3>
                    <p>{formatNumber(stats?.inactive)}</p>
                  </div>
                  <div className="stat-card">
                    <h3>CWCOT</h3>
                    <p>{formatNumber(stats?.cwcot)}</p>
                  </div>
                  <div className="stat-card">
                    <h3>With addendum</h3>
                    <p>{formatNumber(stats?.withAddendum)}</p>
                  </div>
                  <div className="stat-card">
                    <h3>Mappable</h3>
                    <p>{formatNumber(stats?.mappable)}</p>
                  </div>
                  <div className="stat-card">
                    <h3>Unmapped</h3>
                    <p>{formatNumber(stats?.unmapped)}</p>
                  </div>
                  <div className="stat-card">
                    <h3>Counties tracked</h3>
                    <p>{formatNumber(stats?.counties)}</p>
                  </div>
                  <div className="stat-card">
                    <h3>Price range</h3>
                    <p>
                      {formatCurrency(stats?.priceMin)} – {formatCurrency(stats?.priceMax)}
                    </p>
                  </div>
                  <div className="stat-card">
                    <h3>Geocode cache</h3>
                    <p>{formatNumber(geocodeSummary?.cache?.total ?? 0)}</p>
                    <span className="subtext">Updated {formatDate(geocodeSummary?.cache?.mostRecent)}</span>
                  </div>
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
