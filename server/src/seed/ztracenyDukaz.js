// Seed: testovací příběh „Ztracený důkaz“ (6 scén, 2 koncové scény).
// Struktura odpovídá storySchema a sceneSchema v Application Model → Persistence Layer
// (rozhodnutí jsou vnořená v poli scene.decisions).
// Id jsou ve formátu MongoDB ObjectId (24 hex znaků) a shodují se s ukázkami v Command List
// (playthrough/start, playthrough/get), takže dokumentace i testy používají stejná data.
//
// Mapa příběhu:
//
//   1001 Příchod do kavárny (initial)
//     ├─ d001 Objednat si kávu ──────────────► 1002 Rozhovor v kavárně
//     └─ d002 Vklouznout do zadní místnosti ─► 1003 Zadní místnost
//   1002 Rozhovor v kavárně (regular)
//     ├─ d003 Vyptávat se číšníka ───────────► 1004 Číšníkova výpověď
//     └─ d004 Nenápadně do zadní místnosti ──► 1003 Zadní místnost
//   1003 Zadní místnost (regular)
//     ├─ d005 Otevřít trezor ─────────────────► 1005 Důkaz nalezen (final)
//     └─ d006 Vzít kufřík a utéct oknem ──────► 1006 Důkaz ztracen (final)
//   1004 Číšníkova výpověď (regular)
//     ├─ d007 Sledovat muže v šedém kabátě ───► 1005 Důkaz nalezen (final)
//     └─ d008 Zavolat posily a čekat ─────────► 1006 Důkaz ztracen (final)

export const AUTHOR_ID = '100000000000000000001'; // testovací autor „Jan“ (Google sub)

export const story = {
  id: '6720a1f0c2b5a1d3e4f50001',
  name: 'Ztracený důkaz',
  description:
    'Z policejního skladu zmizel klíčový důkaz v případu vraždy. Stopa vede do malé kavárny na okraji města. Najdete ho dřív, než zmizí nadobro?',
  genre: 'Detektivka',
  state: 'published',
  authorId: AUTHOR_ID,
  createdAt: '2026-11-13T18:00:00Z',
  updatedAt: '2026-11-13T18:40:00Z',
  publishedAt: '2026-11-13T18:40:00Z',
};

const S = (n) => `6720a1f0c2b5a1d3e4f5${n}`; // scéna: S('1001')
const D = (n) => `6720a1f0c2b5a1d3e4f5d${n}`; // rozhodnutí: D('001')

const base = { storyId: story.id, createdAt: '2026-11-13T18:05:00Z', updatedAt: '2026-11-13T18:30:00Z' };

export const scenes = [
  {
    ...base,
    id: S('1001'),
    name: 'Příchod do kavárny',
    content:
      'Je deštivé odpoledne. Vcházíte do kavárny U Zlaté lžičky, kde byl naposledy viděn zloděj důkazu. U baru stojí nervózní číšník a dveře do zadní místnosti jsou pootevřené.',
    type: 'initial',
    decisions: [
      { id: D('001'), text: 'Objednat si kávu', targetSceneId: S('1002') },
      { id: D('002'), text: 'Vklouznout rovnou do zadní místnosti', targetSceneId: S('1003') },
    ],
  },
  {
    ...base,
    id: S('1002'),
    name: 'Rozhovor v kavárně',
    content:
      'Číšník je nervózní a při pohledu na váš odznak mu skoro vypadne šálek. U okna sedí muž v šedém kabátě a nenápadně sleduje dveře.',
    type: 'regular',
    decisions: [
      { id: D('003'), text: 'Vyptávat se číšníka', targetSceneId: S('1004') },
      { id: D('004'), text: 'Nenápadně se vytratit do zadní místnosti', targetSceneId: S('1003') },
    ],
  },
  {
    ...base,
    id: S('1003'),
    name: 'Zadní místnost',
    content:
      'Mezi pytli kávy stojí starý trezor a na stole leží kožený kufřík. Z chodby se ozývají kroky, máte jen pár vteřin.',
    type: 'regular',
    decisions: [
      { id: D('005'), text: 'Otevřít trezor', targetSceneId: S('1005') },
      { id: D('006'), text: 'Vzít kufřík a utéct oknem', targetSceneId: S('1006') },
    ],
  },
  {
    ...base,
    id: S('1004'),
    name: 'Číšníkova výpověď',
    content:
      'Číšník se přizná: muž v šedém kabátě mu zaplatil, aby schoval balíček. Právě teď se muž zvedá a míří k východu.',
    type: 'regular',
    decisions: [
      { id: D('007'), text: 'Sledovat muže v šedém kabátě', targetSceneId: S('1005') },
      { id: D('008'), text: 'Zavolat posily a čekat', targetSceneId: S('1006') },
    ],
  },
  {
    ...base,
    id: S('1005'),
    name: 'Důkaz nalezen',
    content:
      'V trezoru i v kapse muže v šedém kabátě najdete zapečetěný sáček s důkazem. Případ může pokračovat a pachatel jde před soud. Gratulujeme, detektive!',
    type: 'final',
    decisions: [],
  },
  {
    ...base,
    id: S('1006'),
    name: 'Důkaz ztracen',
    content:
      'Když se vrátíte, kavárna je prázdná a zadní dveře dokořán. Důkaz zmizel i s mužem v šedém kabátě. Případ se uzavírá bez viníka.',
    type: 'final',
    decisions: [],
  },
];

export default { story, scenes };
