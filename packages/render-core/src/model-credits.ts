/**
 * Who made each 3D model drawn close in, under CC BY 4.0 (GEV's prepared set). Plain data, so
 * the attribution dialog can list them without loading the globe; the globe credits each on
 * screen while it is drawn (render-cesium layers/models.ts).
 */
export type ModelKind =
  'airliner' | 'widebody' | 'turboprop' | 'light' | 'helicopter' | 'business' | 'uav' | 'fast-jet' | 'ship';

export interface ModelCredit {
  title: string;
  author: string;
  authorUrl: string;
  sourceUrl: string;
}

export const MODEL_CREDITS: Readonly<Record<ModelKind, ModelCredit>> = Object.freeze({
  airliner: {
    title: 'boeing 747',
    author: 'zairiq-123',
    authorUrl: 'https://sketchfab.com/zairiq-123',
    sourceUrl: 'https://sketchfab.com/3d-models/boeing-747-9b16672038ba48f98e6d80a159044ed9',
  },
  widebody: {
    title: 'Boeing 787-9',
    author: 'Nobilis 2',
    authorUrl: 'https://sketchfab.com/nobilishornet2',
    sourceUrl: 'https://sketchfab.com/3d-models/boeing-787-9-b6711e2e698e4e469675c1154a50b7a3',
  },
  turboprop: {
    title: 'ATR 72 - 600',
    author: 'Oyan3D',
    authorUrl: 'https://sketchfab.com/oyan3D',
    sourceUrl: 'https://sketchfab.com/3d-models/atr-72-600-1e1a7186f7444d288675262fcee44744',
  },
  light: {
    title: 'Cessna 172',
    author: 'e737',
    authorUrl: 'https://sketchfab.com/e0057537',
    sourceUrl: 'https://sketchfab.com/3d-models/cessna-172-64cddaee5aff470682659a8c08525046',
  },
  helicopter: {
    title: 'Bell 206 JetRanger',
    author: 'terran4627',
    authorUrl: 'https://sketchfab.com/terran4627',
    sourceUrl: 'https://sketchfab.com/3d-models/bell-206-jetranger-d2f7ba1d671549d4b26aaf834139a1dd',
  },
  business: {
    title: '1990 Cessna Citation, Texture Detailed, Exterior',
    author: 'BlenderCommunityHead',
    authorUrl: 'https://sketchfab.com/aboodgoudagad',
    sourceUrl:
      'https://sketchfab.com/3d-models/1990-cessna-citation-texture-detailed-exterior-a78839624fe64900a8352cb23462350a',
  },
  uav: {
    title: 'MQ-9',
    author: 'IProZenoN',
    authorUrl: 'https://sketchfab.com/IProZenoN',
    sourceUrl: 'https://sketchfab.com/3d-models/mq-9-fabe963feb354c5584b51f9c470c3f7e',
  },
  'fast-jet': {
    title: 'Private Jet',
    author: 'Nick the Name',
    authorUrl: 'https://sketchfab.com/Nick_The_Name',
    sourceUrl: 'https://sketchfab.com/3d-models/private-jet-cbdd1de6ced9461e950eafaa302cc82b',
  },
  ship: {
    title: 'Low Poly Cargo Ship',
    author: 'Javier_Fernandez',
    authorUrl: 'https://sketchfab.com/Javier.Fernandez',
    sourceUrl: 'https://sketchfab.com/3d-models/low-poly-cargo-ship-4c22cbaf01c1427f8ab60b3a07b1b32c',
  },
});

export const MODEL_LICENCE_URL = 'https://creativecommons.org/licenses/by/4.0/';

/** The line that credits one model on screen: title, author, licence, and that it was modified. */
export function modelCreditText(c: ModelCredit): string {
  return `3D model “${c.title}” by ${c.author}, CC BY 4.0, modified`;
}

/** The on-screen credits for the kinds drawn, one per model file credited (kinds may share one). */
export function modelCreditLines(kinds: Iterable<ModelKind>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const kind of kinds) {
    const c = MODEL_CREDITS[kind];
    if (!c || seen.has(c.sourceUrl)) continue;
    seen.add(c.sourceUrl);
    out.push(modelCreditText(c));
  }
  return out;
}
