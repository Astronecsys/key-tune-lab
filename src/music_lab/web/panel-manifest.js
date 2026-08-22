export const PANEL_MANIFEST = Object.freeze([
  { id:"layoutPanel", label:"布局", legacyId:"layout", minColumns:4, minRows:8, layouts:{
    compact:{column:0,row:0,columns:12,rows:8}, wide:{column:0,row:0,columns:24,rows:8},
  } },
  { id:"timbrePanel", label:"泛音", legacyId:"timbre", minColumns:4, minRows:8, layouts:{
    compact:{column:0,row:8,columns:4,rows:10}, wide:{column:0,row:8,columns:5,rows:8},
  } },
  { id:"tuningPanel", label:"律制", legacyId:"tuning", minColumns:4, minRows:10, layouts:{
    compact:{column:4,row:8,columns:4,rows:10}, wide:{column:0,row:16,columns:5,rows:10},
  } },
  { id:"mappingPanel", label:"映射", legacyId:"mapping", minColumns:4, minRows:9, layouts:{
    compact:{column:8,row:8,columns:4,rows:10}, wide:{column:0,row:26,columns:5,rows:10},
  } },
  { id:"tracksPanel", label:"轨道", minColumns:6, minRows:10, layouts:{
    compact:{column:0,row:18,columns:8,rows:14}, wide:{column:5,row:18,columns:14,rows:16},
  } },
  { id:"pitchIdentityPanel", label:"音高", minColumns:3, minRows:8, layouts:{
    compact:{column:8,row:18,columns:4,rows:9}, wide:{column:19,row:8,columns:5,rows:9},
  } },
  { id:"chordPanel", label:"和弦关系", minColumns:3, minRows:9, layouts:{
    compact:{column:8,row:27,columns:4,rows:13}, wide:{column:19,row:17,columns:5,rows:13},
  } },
  { id:"spectrumPanel", label:"频谱", minColumns:5, minRows:8, layouts:{
    compact:{column:0,row:32,columns:8,rows:10}, wide:{column:5,row:8,columns:14,rows:10},
  } },
  { id:"lissajousPanel", label:"和弦莉萨如", minColumns:3, minRows:8, layouts:{
    compact:{column:8,row:40,columns:4,rows:10}, wide:{column:19,row:30,columns:5,rows:10},
  } },
  { id:"outputPhasePanel", label:"输出相图", minColumns:3, minRows:8, layouts:{
    compact:{column:0,row:42,columns:8,rows:10}, wide:{column:0,row:36,columns:5,rows:10},
  } },
  { id:"keyboardPanel", label:"键盘", minColumns:6, minRows:8, layouts:{
    compact:{column:0,row:52,columns:12,rows:8}, wide:{column:0,row:46,columns:24,rows:8},
  } },
]);
