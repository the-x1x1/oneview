import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MapAttribution, mapAttributionLead } from './map-attribution.js';

test('folded, the basemap keeps its "Powered by" lead; nothing else is kept', () => {
  assert.equal(
    mapAttributionLead('Powered by Esri — Source: Esri, Maxar, Earthstar Geographics and the GIS User Community'),
    'Powered by Esri',
  );
  assert.equal(mapAttributionLead('© OpenStreetMap contributors'), undefined);
  assert.equal(mapAttributionLead(undefined), undefined);
});

test('unfolded by default, every credit shown with a button to fold them; nothing at all without credits', () => {
  const html = renderToStaticMarkup(createElement(MapAttribution, { credits: ['Powered by Esri — Source: Esri', 'NASA GIBS'] }));
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /Powered by Esri — Source: Esri · NASA GIBS/);
  assert.equal(renderToStaticMarkup(createElement(MapAttribution, { credits: [] })), '');
});
