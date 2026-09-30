import type { PlaceSearchAnswer, SearchResult } from '@worldview/ipc-contract';
import type { IconName, SearchResultItem } from '@worldview/ui';

/**
 * What the top bar's search list shows: the local results (objects, events, commands and
 * the offline gazetteer, as they arrive while typing), then — only when asked — places
 * from the online geocoder (main/place-search.ts).
 *
 * Nothing goes online while typing. The list offers a row, "Search places online for …",
 * and Enter on it (or a click) sends the one request. The row comes first when nothing
 * local is a place, a command or a query, so typing an address and pressing Enter does the
 * obvious thing; when the gazetteer already has places, or the text names a command or a
 * query outright, it goes last, and Enter still picks the first of those.
 * Offline, or with online search switched off in Settings, there is no row, and the footer
 * says why.
 */
export const ONLINE_ROW_ID = 'online:places';

export interface OnlineSearchState {
  /** The text the online search was asked for (normalised). */
  text: string;
  busy: boolean;
  answer: PlaceSearchAnswer | null;
}

const KIND_ICON: Record<SearchResult['kind'], IconName> = {
  place: 'pin',
  object: 'target',
  event: 'activity',
  command: 'command',
  query: 'search',
};

export function normaliseQuery(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

/** "fly to …", "go to …", "take me to …": the words that say *go there*, as the query engine reads them. */
const NAV_PREFIX = /^(?:take me to|go to|(?:fly|jump|zoom|navigate|goto)(?:\s+(?:to|over|into|onto))?)\s+(?=\S)/i;
/** The same words with nothing after them. "fly" alone may be the start of a name, so it is not one. */
const NAV_ONLY = /^(?:take me to|go to|(?:fly|jump|zoom|navigate|goto)\s+(?:to|over|into|onto))$/i;

/**
 * What the online geocoder is asked for: the place, without the words that say *go there*.
 * The local search already reads "fly to Honolulu" as Honolulu; sent whole, the geocoder
 * looked for places called "fly to Honolulu", and "fly to" alone came back with a travel
 * agency and a car park in Turin. Empty when nothing but those words was typed.
 */
export function onlinePlaceText(text: string): string {
  const q = normaliseQuery(text);
  if (NAV_ONLY.test(q)) return '';
  return q.replace(NAV_PREFIX, '');
}

function toItem(r: SearchResult): SearchResultItem {
  return {
    id: r.id,
    title: r.title,
    ...(r.subtitle ? { subtitle: r.subtitle } : {}),
    icon: KIND_ICON[r.kind],
    hint: r.source === 'geocoder' ? 'OSM' : r.kind,
  };
}

/**
 * Local results that Enter should keep: a place, or a command or query the parser is sure of
 * (score 0.9 and up: every word named it). On the laptop "switch to 3D" put the online row
 * above the Switch to 3D command, so Enter asked OpenStreetMap for "switch to 3D" instead.
 */
function answersLocally(r: SearchResult): boolean {
  return r.kind === 'place' || ((r.kind === 'command' || r.kind === 'query') && r.score >= 0.9);
}

export interface SearchListInput {
  text: string;
  local: readonly SearchResult[];
  online: OnlineSearchState | null;
  offline: boolean;
  /** Online place search is switched on (Settings → Search). */
  enabled: boolean;
}

export interface SearchList {
  items: SearchResultItem[];
  /** The results behind `items`, by id, for picking (the online row has none). */
  results: SearchResult[];
  footer: string;
}

export function searchList({ text, local, online, offline, enabled }: SearchListInput): SearchList {
  const q = onlinePlaceText(text);
  const current = online && online.text === q ? online : null;
  const answer = current?.answer ?? null;
  const localIds = new Set(local.map((r) => r.id));
  const found = answer?.status === 'ok' ? answer.results.filter((r) => !localIds.has(r.id)) : [];
  // Places the operator asked for online come first: they pressed Enter for them, and on the
  // laptop a search for "Helsinki" put the city under eleven cameras and a ship of that name.
  const results = [...found, ...local];
  const items = results.map(toItem);

  const canAsk = q.length >= 2 && enabled && !offline;
  // Asked and answered with places: they are in the list, no row needed.
  const answered = answer?.status === 'ok' && answer.results.length > 0;
  if (canAsk && !answered) {
    const row: SearchResultItem = {
      id: ONLINE_ROW_ID,
      title: current?.busy
        ? `Searching OpenStreetMap for “${q}”…`
        : answer
          ? answer.status === 'ok'
            ? `No places online for “${q}”`
            : `Search places online for “${q}” again`
          : `Search places online for “${q}”`,
      subtitle: answer && answer.status !== 'ok' ? answer.message : 'OpenStreetMap (Nominatim) · sends what you typed',
      icon: 'globe',
      hint: 'Enter',
      keepOpen: true,
    };
    if (local.some(answersLocally)) items.push(row);
    else items.unshift(row);
  }

  let footer: string;
  if (offline) footer = 'Offline — searching the local index, cached state and the built-in gazetteer only';
  else if (answered) footer = answer.attribution;
  else if (!enabled) footer = 'Press / to focus · online place search is off (Settings → Search)';
  else
    footer = `Press / to focus · ${local.length ? `${local.length} results` : 'places, callsigns, MMSI, event titles'}`;
  return { items, results, footer };
}
