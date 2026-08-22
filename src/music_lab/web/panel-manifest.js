export const PANEL_MANIFEST = Object.freeze([
  { id:"layoutPanel", legacyId:"layout", minColumns:4, minRows:8, layouts:{
    compact:{column:0,row:0,columns:12,rows:8}, wide:{column:0,row:0,columns:24,rows:8},
  } },
  { id:"timbrePanel", legacyId:"timbre", minColumns:4, minRows:8, layouts:{
    compact:{column:0,row:8,columns:4,rows:10}, wide:{column:0,row:8,columns:5,rows:8},
  } },
  { id:"tuningPanel", legacyId:"tuning", minColumns:4, minRows:10, layouts:{
    compact:{column:4,row:8,columns:4,rows:10}, wide:{column:0,row:16,columns:5,rows:10},
  } },
  { id:"mappingPanel", legacyId:"mapping", minColumns:4, minRows:9, layouts:{
    compact:{column:8,row:8,columns:4,rows:10}, wide:{column:0,row:26,columns:5,rows:10},
  } },
  { id:"tracksPanel", minColumns:6, minRows:10, layouts:{
    compact:{column:0,row:18,columns:8,rows:14}, wide:{column:5,row:18,columns:14,rows:16},
  } },
  { id:"pitchIdentityPanel", minColumns:3, minRows:8, layouts:{
    compact:{column:8,row:18,columns:4,rows:9}, wide:{column:19,row:8,columns:5,rows:9},
  } },
  { id:"chordPanel", minColumns:3, minRows:9, layouts:{
    compact:{column:8,row:27,columns:4,rows:13}, wide:{column:19,row:17,columns:5,rows:13},
  } },
  { id:"spectrumPanel", minColumns:5, minRows:8, layouts:{
    compact:{column:0,row:32,columns:8,rows:10}, wide:{column:5,row:8,columns:14,rows:10},
  } },
  { id:"lissajousPanel", minColumns:3, minRows:8, layouts:{
    compact:{column:8,row:40,columns:4,rows:10}, wide:{column:19,row:30,columns:5,rows:10},
  } },
  { id:"outputPhasePanel", minColumns:3, minRows:8, layouts:{
    compact:{column:0,row:42,columns:8,rows:10}, wide:{column:0,row:36,columns:5,rows:10},
  } },
  { id:"keyboardPanel", minColumns:6, minRows:8, layouts:{
    compact:{column:0,row:52,columns:12,rows:8}, wide:{column:0,row:46,columns:24,rows:8},
  } },
]);
