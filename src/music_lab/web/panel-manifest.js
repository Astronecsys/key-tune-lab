export const PANEL_MANIFEST = Object.freeze([
  { id:"timbrePanel", legacyId:"timbre", minColumns:4, minRows:8, layouts:{
    compact:{column:0,row:0,columns:4,rows:10}, wide:{column:0,row:0,columns:5,rows:8},
  } },
  { id:"tuningPanel", legacyId:"tuning", minColumns:4, minRows:10, layouts:{
    compact:{column:4,row:0,columns:4,rows:10}, wide:{column:0,row:8,columns:5,rows:10},
  } },
  { id:"mappingPanel", legacyId:"mapping", minColumns:4, minRows:9, layouts:{
    compact:{column:8,row:0,columns:4,rows:10}, wide:{column:0,row:18,columns:5,rows:10},
  } },
  { id:"tracksPanel", minColumns:6, minRows:10, layouts:{
    compact:{column:0,row:10,columns:8,rows:14}, wide:{column:5,row:10,columns:14,rows:16},
  } },
  { id:"pitchIdentityPanel", minColumns:3, minRows:8, layouts:{
    compact:{column:8,row:10,columns:4,rows:9}, wide:{column:19,row:0,columns:5,rows:9},
  } },
  { id:"chordPanel", minColumns:3, minRows:9, layouts:{
    compact:{column:8,row:19,columns:4,rows:13}, wide:{column:19,row:9,columns:5,rows:13},
  } },
  { id:"spectrumPanel", minColumns:5, minRows:8, layouts:{
    compact:{column:0,row:24,columns:8,rows:10}, wide:{column:5,row:0,columns:14,rows:10},
  } },
  { id:"lissajousPanel", minColumns:3, minRows:8, layouts:{
    compact:{column:8,row:32,columns:4,rows:10}, wide:{column:19,row:22,columns:5,rows:10},
  } },
  { id:"outputPhasePanel", minColumns:3, minRows:8, layouts:{
    compact:{column:0,row:34,columns:8,rows:10}, wide:{column:0,row:28,columns:5,rows:10},
  } },
  { id:"keyboardPanel", minColumns:6, minRows:8, layouts:{
    compact:{column:0,row:44,columns:12,rows:8}, wide:{column:0,row:38,columns:24,rows:8},
  } },
]);
