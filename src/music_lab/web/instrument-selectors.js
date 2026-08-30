const isBlackMidiNote = (note) => [1, 3, 6, 8, 10].includes(note % 12);

export function selectKeyboardView(snapshot) {
  const keyboard = snapshot.keyboard;
  const keys = keyboard.keys.map((key, index) => {
    const midiNote = key.input_midi_note ?? key.midi_note ?? null;
    return {
      ...key,
      input_node_id:key.input_node_id || (midiNote === null ? `node:${index}` : `midi:${midiNote}`),
      input_index:key.input_index ?? index,
      input_label:key.input_label || key.key_label || (midiNote === null ? `N${index}` : `K${midiNote}`),
      input_role:key.input_role || (midiNote !== null && isBlackMidiNote(midiNote) ? "black" : "white"),
      input_midi_note:midiNote,
      coordinate:key.coordinate || [index],
    };
  });
  const legacyAnchor = keyboard.mapping?.anchor ?? snapshot.tuning.reference_midi;
  const anchorKey = keys.find((key) => key.input_midi_note === legacyAnchor)
    || keys.find((key) => key.input_midi_note === snapshot.tuning.reference_midi)
    || keys[0];
  return {
    ...keyboard,
    keys,
    surface:keyboard.surface || {
      id:"legacy_piano",
      name:"当前钢琴键盘",
      description:"旧版会话中的 MIDI 钢琴表面",
      kind:"piano",
      node_count:keys.length,
    },
    mapping:{
      surface_id:keyboard.surface?.id || "legacy_piano",
      mode:"continuous",
      anchor_node_id:anchorKey?.input_node_id || "",
      reference_degree:snapshot.tuning.reference_degree ?? 0,
      reference_frequency_hz:snapshot.tuning.reference_frequency_hz,
      degree_step:1,
      subset_degrees:[],
      q_step:1,
      r_step:5,
      q_ratio_expression:"3/2",
      r_ratio_expression:"5/4",
      ...keyboard.mapping,
      anchor_node_id:keyboard.mapping?.anchor_node_id || anchorKey?.input_node_id || "",
    },
  };
}

export function selectTuningSpace(snapshot) {
  const tuning = snapshot.tuning;
  if (tuning.space) return tuning.space;
  const degreeCount = Math.max(1, Number(tuning.divisions) || 12);
  const equave = Number(tuning.equave_ratio) || 2;
  const degrees = Array.from({length:degreeCount}, (_, index) => ({
    id:`d${index}`,
    index,
    expression:`${equave}^(${index}/${degreeCount})`,
    ratio:equave ** (index / degreeCount),
    normalized_position:index / degreeCount,
  }));
  return {
    equave_expression:String(equave),
    equave_ratio:equave,
    degree_count:degreeCount,
    degrees,
    construction:{kind:"equal_division", degree_count:degreeCount},
  };
}

