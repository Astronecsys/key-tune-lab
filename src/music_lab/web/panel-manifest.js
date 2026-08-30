export const DESKTOP_MANIFEST = Object.freeze([
  {id:"desktop1", label:"演奏桌面", shortLabel:"D1", shortcut:"Alt+1"},
  {id:"desktop2", label:"布局桌面", shortLabel:"D2", shortcut:"Alt+2"},
]);

export const PANEL_MANIFEST = Object.freeze([
  { id:"layoutPanel", label:"布局", desktop:"desktop2", legacyId:"layout", minColumns:4, minRows:12, layouts:{
    compact:{column:0,row:0,columns:12,rows:12}, wide:{column:0,row:0,columns:24,rows:12},
  } },
  { id:"timbrePanel", label:"泛音", desktop:"desktop1", legacyId:"timbre", minColumns:4, minRows:8, layouts:{
    compact:{column:0,row:0,columns:4,rows:10}, wide:{column:0,row:0,columns:5,rows:8},
  } },
  { id:"tuningPanel", label:"律制", desktop:"desktop1", legacyId:"tuning", minColumns:4, minRows:10, layouts:{
    compact:{column:4,row:0,columns:4,rows:10}, wide:{column:0,row:8,columns:5,rows:10},
  } },
  { id:"mappingPanel", label:"映射", desktop:"desktop1", legacyId:"mapping", minColumns:4, minRows:9, layouts:{
    compact:{column:8,row:0,columns:4,rows:10}, wide:{column:0,row:18,columns:5,rows:10},
  } },
  { id:"tracksPanel", label:"轨道", desktop:"desktop1", minColumns:6, minRows:10, layouts:{
    compact:{column:0,row:10,columns:8,rows:14}, wide:{column:5,row:10,columns:14,rows:16},
  } },
  { id:"pitchIdentityPanel", label:"音高", desktop:"desktop1", minColumns:3, minRows:8, layouts:{
    compact:{column:8,row:10,columns:4,rows:9}, wide:{column:19,row:0,columns:5,rows:9},
  } },
  { id:"chordPanel", label:"和弦关系", desktop:"desktop1", minColumns:3, minRows:9, layouts:{
    compact:{column:8,row:19,columns:4,rows:13}, wide:{column:19,row:9,columns:5,rows:13},
  } },
  { id:"spectrumPanel", label:"频谱", desktop:"desktop1", minColumns:5, minRows:8, layouts:{
    compact:{column:0,row:24,columns:8,rows:10}, wide:{column:5,row:0,columns:14,rows:10},
  } },
  { id:"lissajousPanel", label:"和弦莉萨如", desktop:"desktop1", minColumns:3, minRows:8, layouts:{
    compact:{column:8,row:32,columns:4,rows:10}, wide:{column:19,row:22,columns:5,rows:10},
  } },
  { id:"outputPhasePanel", label:"输出相图", desktop:"desktop1", minColumns:3, minRows:8, layouts:{
    compact:{column:0,row:34,columns:8,rows:10}, wide:{column:0,row:28,columns:5,rows:10},
  } },
  { id:"keyboardPanel", label:"键盘", desktop:"desktop1", minColumns:6, minRows:8, layouts:{
    compact:{column:0,row:44,columns:12,rows:8}, wide:{column:0,row:38,columns:24,rows:8},
  } },
]);
