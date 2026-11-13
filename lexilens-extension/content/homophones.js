/*
 * LexiLens confusion-pair dictionary.
 *
 * Classic script (not an ES module). No dependencies, no DOM access.
 * Loads in a content script and in Node.
 *
 * Each group lists words that are easily confused with each other.
 *   kind: 'sound-alike'  true homophones, or near homophones
 *         'look-alike'   visually confusable spellings
 *   w:    lowercase word (straight apostrophes)
 *   icon: one emoji used as a visual memory anchor
 *   def:  plain-English meaning, five words at most
 *
 * A word appears in exactly one group, because the index maps word -> group.
 */
(function () {
  'use strict';

  const LL = (globalThis.LexiLens = globalThis.LexiLens || {});

  LL.HOMOPHONES = [
    // ---------------------------------------------------------------
    // Core academic pairs
    // ---------------------------------------------------------------
    { id: 'affect-effect', kind: 'sound-alike', words: [
      { w: 'affect', icon: '🎯', def: 'to influence or change something' },
      { w: 'effect', icon: '💥', def: 'the result of a change' },
    ] },
    { id: 'their-there-theyre', kind: 'sound-alike', words: [
      { w: 'their', icon: '👥', def: 'belonging to them' },
      { w: 'there', icon: '📍', def: 'in that place' },
      { w: "they're", icon: '🙋', def: 'short for they are' },
    ] },
    { id: 'to-too-two', kind: 'sound-alike', words: [
      { w: 'to', icon: '➡️', def: 'toward a place' },
      { w: 'too', icon: '➕', def: 'also, or more than needed' },
      { w: 'two', icon: '✌️', def: 'the number 2' },
    ] },
    { id: 'your-youre', kind: 'sound-alike', words: [
      { w: 'your', icon: '👉', def: 'belonging to you' },
      { w: "you're", icon: '🙂', def: 'short for you are' },
    ] },
    { id: 'its-its', kind: 'sound-alike', words: [
      { w: 'its', icon: '🐕', def: 'belonging to that thing' },
      { w: "it's", icon: '💬', def: 'short for it is' },
    ] },
    { id: 'whose-whos', kind: 'sound-alike', words: [
      { w: 'whose', icon: '🔑', def: 'belonging to which person' },
      { w: "who's", icon: '❓', def: 'short for who is' },
    ] },
    { id: 'than-then', kind: 'sound-alike', words: [
      { w: 'than', icon: '⚖️', def: 'used to compare things' },
      { w: 'then', icon: '⏭️', def: 'after that, next' },
    ] },
    { id: 'accept-except-expect', kind: 'sound-alike', words: [
      { w: 'accept', icon: '🤝', def: 'to agree to take' },
      { w: 'except', icon: '🚫', def: 'not including, leaving out' },
      { w: 'expect', icon: '🔮', def: 'to think something will happen' },
    ] },
    { id: 'allusion-illusion', kind: 'sound-alike', words: [
      { w: 'allusion', icon: '📖', def: 'an indirect reference' },
      { w: 'illusion', icon: '🎩', def: 'a false or tricky image' },
    ] },
    { id: 'cite-site-sight', kind: 'sound-alike', words: [
      { w: 'cite', icon: '📝', def: 'to quote a source' },
      { w: 'site', icon: '🏗️', def: 'a place or location' },
      { w: 'sight', icon: '👀', def: 'the ability to see' },
    ] },
    { id: 'council-counsel', kind: 'sound-alike', words: [
      { w: 'council', icon: '🏛️', def: 'a group that makes decisions' },
      { w: 'counsel', icon: '🗣️', def: 'guidance, or to guide' },
    ] },
    { id: 'desert-dessert', kind: 'sound-alike', words: [
      { w: 'desert', icon: '🏜️', def: 'dry sandy land; to abandon' },
      { w: 'dessert', icon: '🍰', def: 'sweet food after a meal' },
    ] },
    { id: 'precede-proceed', kind: 'sound-alike', words: [
      { w: 'precede', icon: '⏮️', def: 'to come before' },
      { w: 'proceed', icon: '▶️', def: 'to go ahead, continue' },
    ] },
    { id: 'weather-whether', kind: 'sound-alike', words: [
      { w: 'weather', icon: '⛅', def: 'rain, sun, wind outside' },
      { w: 'whether', icon: '🤔', def: 'if, showing a choice' },
    ] },
    { id: 'discrete-discreet', kind: 'sound-alike', words: [
      { w: 'discrete', icon: '🧩', def: 'separate and distinct' },
      { w: 'discreet', icon: '🤫', def: 'careful and quietly private' },
    ] },
    { id: 'principal-principle', kind: 'sound-alike', words: [
      { w: 'principal', icon: '🏫', def: 'main, or head of school' },
      { w: 'principle', icon: '📜', def: 'a basic rule or belief' },
    ] },
    { id: 'elicit-illicit', kind: 'sound-alike', words: [
      { w: 'elicit', icon: '🎣', def: 'to draw out a response' },
      { w: 'illicit', icon: '🚫', def: 'illegal or not allowed' },
    ] },
    { id: 'compliment-complement', kind: 'sound-alike', words: [
      { w: 'compliment', icon: '👏', def: 'a kind, praising remark' },
      { w: 'complement', icon: '🧩', def: 'something that completes another' },
    ] },
    { id: 'stationary-stationery', kind: 'sound-alike', words: [
      { w: 'stationary', icon: '🛑', def: 'not moving, standing still' },
      { w: 'stationery', icon: '✉️', def: 'paper and writing supplies' },
    ] },

    // ---------------------------------------------------------------
    // Sound-alike: academic and everyday
    // ---------------------------------------------------------------
    { id: 'advice-advise', kind: 'sound-alike', words: [
      { w: 'advice', icon: '💡', def: 'a helpful suggestion (noun)' },
      { w: 'advise', icon: '🗣️', def: 'to give suggestions (verb)' },
    ] },
    { id: 'access-excess', kind: 'sound-alike', words: [
      { w: 'access', icon: '🚪', def: 'a way to enter' },
      { w: 'excess', icon: '📈', def: 'too much of something' },
    ] },
    { id: 'ensure-insure-assure', kind: 'sound-alike', words: [
      { w: 'ensure', icon: '✅', def: 'to make certain it happens' },
      { w: 'insure', icon: '🛡️', def: 'to protect with a policy' },
      { w: 'assure', icon: '🤝', def: 'to promise someone confidently' },
    ] },
    { id: 'lead-led', kind: 'sound-alike', words: [
      { w: 'lead', icon: '🧭', def: 'to guide; also a metal' },
      { w: 'led', icon: '🚶', def: 'guided, in the past' },
    ] },
    { id: 'passed-past', kind: 'sound-alike', words: [
      { w: 'passed', icon: '🏃', def: 'went by, or succeeded' },
      { w: 'past', icon: '🕰️', def: 'time before now' },
    ] },
    { id: 'peace-piece', kind: 'sound-alike', words: [
      { w: 'peace', icon: '🕊️', def: 'calm, no war' },
      { w: 'piece', icon: '🧩', def: 'a part of something' },
    ] },
    { id: 'plain-plane', kind: 'sound-alike', words: [
      { w: 'plain', icon: '🌾', def: 'simple, or flat land' },
      { w: 'plane', icon: '✈️', def: 'an aircraft or flat surface' },
    ] },
    { id: 'break-brake', kind: 'sound-alike', words: [
      { w: 'break', icon: '🔨', def: 'to smash, or a rest' },
      { w: 'brake', icon: '🛑', def: 'device that stops a vehicle' },
    ] },
    { id: 'bare-bear', kind: 'sound-alike', words: [
      { w: 'bare', icon: '🦶', def: 'uncovered or empty' },
      { w: 'bear', icon: '🐻', def: 'an animal, or to carry' },
    ] },
    { id: 'capital-capitol', kind: 'sound-alike', words: [
      { w: 'capital', icon: '💰', def: 'main city, or money' },
      { w: 'capitol', icon: '🏛️', def: 'building where lawmakers meet' },
    ] },
    { id: 'coarse-course', kind: 'sound-alike', words: [
      { w: 'coarse', icon: '🧱', def: 'rough, not smooth' },
      { w: 'course', icon: '🎓', def: 'a class, or a path' },
    ] },
    { id: 'device-devise', kind: 'sound-alike', words: [
      { w: 'device', icon: '📱', def: 'a tool or gadget (noun)' },
      { w: 'devise', icon: '🧠', def: 'to plan or invent (verb)' },
    ] },
    { id: 'eminent-imminent', kind: 'sound-alike', words: [
      { w: 'eminent', icon: '🌟', def: 'famous and respected' },
      { w: 'imminent', icon: '⏰', def: 'about to happen soon' },
    ] },
    { id: 'farther-further', kind: 'sound-alike', words: [
      { w: 'farther', icon: '📏', def: 'at a greater physical distance' },
      { w: 'further', icon: '➕', def: 'more, in addition' },
    ] },
    { id: 'formally-formerly', kind: 'sound-alike', words: [
      { w: 'formally', icon: '🤵', def: 'in an official, proper way' },
      { w: 'formerly', icon: '🕰️', def: 'in the past, before' },
    ] },
    { id: 'right-write-rite', kind: 'sound-alike', words: [
      { w: 'right', icon: '✅', def: 'correct, or opposite of left' },
      { w: 'write', icon: '✍️', def: 'to put words on paper' },
      { w: 'rite', icon: '🕯️', def: 'a ceremony or ritual' },
    ] },
    { id: 'role-roll', kind: 'sound-alike', words: [
      { w: 'role', icon: '🎭', def: 'a part or job' },
      { w: 'roll', icon: '🎲', def: 'to turn over and over' },
    ] },
    { id: 'sole-soul', kind: 'sound-alike', words: [
      { w: 'sole', icon: '👟', def: 'only one; shoe bottom' },
      { w: 'soul', icon: '👻', def: "a person's spirit" },
    ] },
    { id: 'waist-waste', kind: 'sound-alike', words: [
      { w: 'waist', icon: '👖', def: 'middle of the body' },
      { w: 'waste', icon: '🗑️', def: 'to use badly; trash' },
    ] },
    { id: 'weak-week', kind: 'sound-alike', words: [
      { w: 'weak', icon: '🥀', def: 'not strong' },
      { w: 'week', icon: '📅', def: 'seven days' },
    ] },
    { id: 'which-witch', kind: 'sound-alike', words: [
      { w: 'which', icon: '❓', def: 'what one, of several' },
      { w: 'witch', icon: '🧙', def: 'a person who casts spells' },
    ] },
    { id: 'hear-here', kind: 'sound-alike', words: [
      { w: 'hear', icon: '👂', def: 'to notice sound' },
      { w: 'here', icon: '📍', def: 'in this place' },
    ] },
    { id: 'know-no', kind: 'sound-alike', words: [
      { w: 'know', icon: '🧠', def: 'to understand or be sure' },
      { w: 'no', icon: '🚫', def: 'the opposite of yes' },
    ] },
    { id: 'new-knew', kind: 'sound-alike', words: [
      { w: 'new', icon: '✨', def: 'not old, just made' },
      { w: 'knew', icon: '🧠', def: 'understood, in the past' },
    ] },
    { id: 'buy-by-bye', kind: 'sound-alike', words: [
      { w: 'buy', icon: '🛒', def: 'to pay for something' },
      { w: 'by', icon: '👉', def: 'beside, or done through' },
      { w: 'bye', icon: '👋', def: 'short for goodbye' },
    ] },
    { id: 'allowed-aloud', kind: 'sound-alike', words: [
      { w: 'allowed', icon: '✅', def: 'given permission' },
      { w: 'aloud', icon: '🔊', def: 'spoken so others hear' },
    ] },
    { id: 'altar-alter', kind: 'sound-alike', words: [
      { w: 'altar', icon: '⛪', def: 'a table for worship' },
      { w: 'alter', icon: '🔧', def: 'to change something' },
    ] },
    { id: 'ascent-assent', kind: 'sound-alike', words: [
      { w: 'ascent', icon: '🧗', def: 'a climb upward' },
      { w: 'assent', icon: '👍', def: 'agreement or approval' },
    ] },
    { id: 'aural-oral', kind: 'sound-alike', words: [
      { w: 'aural', icon: '👂', def: 'about hearing' },
      { w: 'oral', icon: '👄', def: 'spoken, or about the mouth' },
    ] },
    { id: 'bazaar-bizarre', kind: 'sound-alike', words: [
      { w: 'bazaar', icon: '🛍️', def: 'a street market' },
      { w: 'bizarre', icon: '🤪', def: 'very strange' },
    ] },
    { id: 'canvas-canvass', kind: 'sound-alike', words: [
      { w: 'canvas', icon: '🎨', def: 'strong cloth for painting' },
      { w: 'canvass', icon: '🗳️', def: 'to ask people for votes' },
    ] },
    { id: 'censor-sensor-censure', kind: 'sound-alike', words: [
      { w: 'censor', icon: '✂️', def: 'to cut out content' },
      { w: 'sensor', icon: '📡', def: 'a device that detects things' },
      { w: 'censure', icon: '👎', def: 'strong official criticism' },
    ] },
    { id: 'cereal-serial', kind: 'sound-alike', words: [
      { w: 'cereal', icon: '🥣', def: 'a grain breakfast food' },
      { w: 'serial', icon: '🔢', def: 'happening in a series' },
    ] },
    { id: 'dual-duel', kind: 'sound-alike', words: [
      { w: 'dual', icon: '👯', def: 'having two parts' },
      { w: 'duel', icon: '⚔️', def: 'a fight between two people' },
    ] },
    { id: 'flair-flare', kind: 'sound-alike', words: [
      { w: 'flair', icon: '🎨', def: 'natural talent or style' },
      { w: 'flare', icon: '🔥', def: 'a sudden bright flame' },
    ] },
    { id: 'foreword-forward', kind: 'sound-alike', words: [
      { w: 'foreword', icon: '📖', def: 'a short book introduction' },
      { w: 'forward', icon: '⏩', def: 'toward the front, ahead' },
    ] },
    { id: 'gorilla-guerrilla', kind: 'sound-alike', words: [
      { w: 'gorilla', icon: '🦍', def: 'a large ape' },
      { w: 'guerrilla', icon: '🎖️', def: 'a fighter using surprise attacks' },
    ] },
    { id: 'hoard-horde', kind: 'sound-alike', words: [
      { w: 'hoard', icon: '📦', def: 'to store up secretly' },
      { w: 'horde', icon: '👥', def: 'a large crowd' },
    ] },
    { id: 'pore-pour-poor', kind: 'sound-alike', words: [
      { w: 'pore', icon: '🔬', def: 'tiny skin opening; study closely' },
      { w: 'pour', icon: '☕', def: 'to make liquid flow' },
      { w: 'poor', icon: '💸', def: 'having little money' },
    ] },
    { id: 'rain-reign-rein', kind: 'sound-alike', words: [
      { w: 'rain', icon: '🌧️', def: 'water falling from clouds' },
      { w: 'reign', icon: '👑', def: 'to rule as monarch' },
      { w: 'rein', icon: '🐴', def: 'strap to guide a horse' },
    ] },
    { id: 'vain-vein-vane', kind: 'sound-alike', words: [
      { w: 'vain', icon: '💅', def: 'too proud; without success' },
      { w: 'vein', icon: '🩸', def: 'tube that carries blood' },
      { w: 'vane', icon: '🌬️', def: 'a blade showing wind direction' },
    ] },
    { id: 'waive-wave', kind: 'sound-alike', words: [
      { w: 'waive', icon: '🙅', def: 'to give up a right' },
      { w: 'wave', icon: '🌊', def: 'a moving ridge; hand motion' },
    ] },
    { id: 'were-where-wear-were', kind: 'sound-alike', words: [
      { w: 'were', icon: '⏪', def: 'past form of are' },
      { w: 'where', icon: '🗺️', def: 'in what place' },
      { w: 'wear', icon: '👕', def: 'to have clothes on' },
      { w: "we're", icon: '👫', def: 'short for we are' },
    ] },
    { id: 'aid-aide', kind: 'sound-alike', words: [
      { w: 'aid', icon: '🩹', def: 'help or support' },
      { w: 'aide', icon: '📋', def: 'an assistant, a helper' },
    ] },
    { id: 'born-borne', kind: 'sound-alike', words: [
      { w: 'born', icon: '👶', def: 'brought into life' },
      { w: 'borne', icon: '🎒', def: 'carried, or put up with' },
    ] },
    { id: 'heal-heel', kind: 'sound-alike', words: [
      { w: 'heal', icon: '🩹', def: 'to become healthy again' },
      { w: 'heel', icon: '👠', def: 'back part of the foot' },
    ] },
    { id: 'hole-whole', kind: 'sound-alike', words: [
      { w: 'hole', icon: '🕳️', def: 'an empty opening' },
      { w: 'whole', icon: '🌕', def: 'complete, all parts' },
    ] },
    { id: 'patience-patients', kind: 'sound-alike', words: [
      { w: 'patience', icon: '⏳', def: 'calm ability to wait' },
      { w: 'patients', icon: '🏥', def: 'people getting medical care' },
    ] },
    { id: 'presence-presents', kind: 'sound-alike', words: [
      { w: 'presence', icon: '🙋', def: 'being in a place' },
      { w: 'presents', icon: '🎁', def: 'gifts; or shows something' },
    ] },
    { id: 'scene-seen', kind: 'sound-alike', words: [
      { w: 'scene', icon: '🎬', def: 'a setting or view' },
      { w: 'seen', icon: '👀', def: 'noticed with the eyes' },
    ] },
    { id: 'sea-see', kind: 'sound-alike', words: [
      { w: 'sea', icon: '🌊', def: 'large body of salt water' },
      { w: 'see', icon: '👀', def: 'to notice with eyes' },
    ] },
    { id: 'steal-steel', kind: 'sound-alike', words: [
      { w: 'steal', icon: '🦝', def: 'to take without permission' },
      { w: 'steel', icon: '🔩', def: 'a strong metal' },
    ] },
    { id: 'tail-tale', kind: 'sound-alike', words: [
      { w: 'tail', icon: '🦊', def: 'back end of an animal' },
      { w: 'tale', icon: '📚', def: 'a story' },
    ] },
    { id: 'emigrate-immigrate', kind: 'sound-alike', words: [
      { w: 'emigrate', icon: '🛫', def: 'to leave your country' },
      { w: 'immigrate', icon: '🛬', def: 'to move into a country' },
    ] },
    { id: 'board-bored', kind: 'sound-alike', words: [
      { w: 'board', icon: '📋', def: 'a flat plank; a committee' },
      { w: 'bored', icon: '😴', def: 'not interested, restless' },
    ] },
    { id: 'higher-hire', kind: 'sound-alike', words: [
      { w: 'higher', icon: '⬆️', def: 'more elevated, further up' },
      { w: 'hire', icon: '💼', def: 'to give someone a job' },
    ] },
    { id: 'minor-miner', kind: 'sound-alike', words: [
      { w: 'minor', icon: '🧒', def: 'small; under adult age' },
      { w: 'miner', icon: '⛏️', def: 'a person who digs underground' },
    ] },
    { id: 'fair-fare', kind: 'sound-alike', words: [
      { w: 'fair', icon: '⚖️', def: 'just, equal; a festival' },
      { w: 'fare', icon: '🎫', def: 'the price of a ride' },
    ] },
    { id: 'cue-queue', kind: 'sound-alike', words: [
      { w: 'cue', icon: '🎬', def: 'a signal to act' },
      { w: 'queue', icon: '🧍', def: 'a line of people waiting' },
    ] },
    { id: 'morning-mourning', kind: 'sound-alike', words: [
      { w: 'morning', icon: '🌅', def: 'early part of the day' },
      { w: 'mourning', icon: '🖤', def: 'grief after a death' },
    ] },
    { id: 'aisle-isle', kind: 'sound-alike', words: [
      { w: 'aisle', icon: '🛒', def: 'a walkway between rows' },
      { w: 'isle', icon: '🏝️', def: 'a small island' },
    ] },
    { id: 'lesson-lessen', kind: 'sound-alike', words: [
      { w: 'lesson', icon: '📚', def: 'something taught or learned' },
      { w: 'lessen', icon: '📉', def: 'to make smaller' },
    ] },
    { id: 'incite-insight', kind: 'sound-alike', words: [
      { w: 'incite', icon: '🔥', def: 'to stir up trouble' },
      { w: 'insight', icon: '💡', def: 'a deep understanding' },
    ] },
    { id: 'idle-idol', kind: 'sound-alike', words: [
      { w: 'idle', icon: '🛋️', def: 'not working or active' },
      { w: 'idol', icon: '⭐', def: 'someone greatly admired' },
    ] },
    { id: 'defuse-diffuse', kind: 'sound-alike', words: [
      { w: 'defuse', icon: '💣', def: 'to calm a tense situation' },
      { w: 'diffuse', icon: '🌫️', def: 'to spread out widely' },
    ] },
    { id: 'peak-peek-pique', kind: 'sound-alike', words: [
      { w: 'peak', icon: '⛰️', def: 'the highest point' },
      { w: 'peek', icon: '👀', def: 'a quick secret look' },
      { w: 'pique', icon: '🧲', def: 'to stir up interest' },
    ] },
    { id: 'palate-palette-pallet', kind: 'sound-alike', words: [
      { w: 'palate', icon: '👅', def: 'roof of mouth; taste' },
      { w: 'palette', icon: '🎨', def: 'a range of colors' },
      { w: 'pallet', icon: '📦', def: 'a wooden shipping platform' },
    ] },
    { id: 'assistance-assistants', kind: 'sound-alike', words: [
      { w: 'assistance', icon: '🆘', def: 'help or support' },
      { w: 'assistants', icon: '👥', def: 'people who help' },
    ] },
    { id: 'allude-elude', kind: 'sound-alike', words: [
      { w: 'allude', icon: '👉', def: 'to hint at indirectly' },
      { w: 'elude', icon: '💨', def: 'to escape or avoid' },
    ] },
    { id: 'for-four-fore', kind: 'sound-alike', words: [
      { w: 'for', icon: '🎁', def: 'meant to be given to' },
      { w: 'four', icon: '🍀', def: 'the number 4' },
      { w: 'fore', icon: '⛳', def: 'at the front' },
    ] },
    { id: 'forth-fourth', kind: 'sound-alike', words: [
      { w: 'forth', icon: '🚀', def: 'forward, onward' },
      { w: 'fourth', icon: '4️⃣', def: 'number 4 in order' },
    ] },
    { id: 'our-hour-are', kind: 'sound-alike', words: [
      { w: 'our', icon: '👪', def: 'belonging to us' },
      { w: 'hour', icon: '🕐', def: 'sixty minutes' },
      { w: 'are', icon: '🔗', def: 'present form of be' },
    ] },
    { id: 'decent-descent-dissent', kind: 'sound-alike', words: [
      { w: 'decent', icon: '👍', def: 'good enough; respectable' },
      { w: 'descent', icon: '⬇️', def: 'a movement downward' },
      { w: 'dissent', icon: '✊', def: 'strong disagreement' },
    ] },
    { id: 'heard-herd', kind: 'sound-alike', words: [
      { w: 'heard', icon: '👂', def: 'sensed a sound before' },
      { w: 'herd', icon: '🐄', def: 'a group of animals' },
    ] },
    { id: 'pole-poll', kind: 'sound-alike', words: [
      { w: 'pole', icon: '🚩', def: 'a long thin rod' },
      { w: 'poll', icon: '🗳️', def: 'a survey or vote' },
    ] },
    { id: 'addition-edition', kind: 'sound-alike', words: [
      { w: 'addition', icon: '➕', def: 'adding; something added' },
      { w: 'edition', icon: '📚', def: 'one version of a book' },
    ] },
    { id: 'cell-sell', kind: 'sound-alike', words: [
      { w: 'cell', icon: '🔬', def: 'smallest unit of life' },
      { w: 'sell', icon: '🏷️', def: 'to trade for money' },
    ] },
    { id: 'sent-scent-cent', kind: 'sound-alike', words: [
      { w: 'sent', icon: '📨', def: 'made to go, mailed' },
      { w: 'scent', icon: '🌸', def: 'a smell' },
      { w: 'cent', icon: '💲', def: 'one hundredth of a dollar' },
    ] },
    { id: 'weight-wait', kind: 'sound-alike', words: [
      { w: 'weight', icon: '⚖️', def: 'how heavy something is' },
      { w: 'wait', icon: '⏳', def: 'to stay until later' },
    ] },
    { id: 'seam-seem', kind: 'sound-alike', words: [
      { w: 'seam', icon: '🧵', def: 'line where fabric joins' },
      { w: 'seem', icon: '🤔', def: 'to appear to be' },
    ] },
    { id: 'some-sum', kind: 'sound-alike', words: [
      { w: 'some', icon: '🍪', def: 'a few, an amount' },
      { w: 'sum', icon: '➕', def: 'a total from adding' },
    ] },
    { id: 'would-wood', kind: 'sound-alike', words: [
      { w: 'would', icon: '💭', def: 'shows a possible action' },
      { w: 'wood', icon: '🌲', def: 'material from trees' },
    ] },
    { id: 'root-route', kind: 'sound-alike', words: [
      { w: 'root', icon: '🌱', def: 'underground plant part; origin' },
      { w: 'route', icon: '🗺️', def: 'a way to travel' },
    ] },
    { id: 'straight-strait', kind: 'sound-alike', words: [
      { w: 'straight', icon: '📏', def: 'not bent or curved' },
      { w: 'strait', icon: '🌊', def: 'narrow channel of water' },
    ] },
    { id: 'taught-taut', kind: 'sound-alike', words: [
      { w: 'taught', icon: '🎓', def: 'gave lessons, from teach' },
      { w: 'taut', icon: '🎸', def: 'pulled tight' },
    ] },
    { id: 'vary-very', kind: 'sound-alike', words: [
      { w: 'vary', icon: '🔀', def: 'to change or differ' },
      { w: 'very', icon: '‼️', def: 'extremely, a lot' },
    ] },
    { id: 'pray-prey', kind: 'sound-alike', words: [
      { w: 'pray', icon: '🙏', def: 'to speak to a god' },
      { w: 'prey', icon: '🐭', def: 'an animal that is hunted' },
    ] },
    { id: 'manner-manor', kind: 'sound-alike', words: [
      { w: 'manner', icon: '🙇', def: 'a way of behaving' },
      { w: 'manor', icon: '🏰', def: 'a large country house' },
    ] },
    { id: 'residence-residents', kind: 'sound-alike', words: [
      { w: 'residence', icon: '🏠', def: 'a home, place to live' },
      { w: 'residents', icon: '👥', def: 'people who live somewhere' },
    ] },
    { id: 'profit-prophet', kind: 'sound-alike', words: [
      { w: 'profit', icon: '💰', def: 'money gained' },
      { w: 'prophet', icon: '🔮', def: 'one who foretells the future' },
    ] },
    { id: 'overdo-overdue', kind: 'sound-alike', words: [
      { w: 'overdo', icon: '🥵', def: 'to do too much' },
      { w: 'overdue', icon: '📅', def: 'late, past the deadline' },
    ] },
    { id: 'undo-undue', kind: 'sound-alike', words: [
      { w: 'undo', icon: '↩️', def: 'to reverse an action' },
      { w: 'undue', icon: '⚠️', def: 'too much, not justified' },
    ] },
    { id: 'loan-lone', kind: 'sound-alike', words: [
      { w: 'loan', icon: '🏦', def: 'money lent to someone' },
      { w: 'lone', icon: '🐺', def: 'alone, the only one' },
    ] },
    { id: 'stake-steak', kind: 'sound-alike', words: [
      { w: 'stake', icon: '📍', def: 'a pointed post; a share' },
      { w: 'steak', icon: '🥩', def: 'a slice of meat' },
    ] },
    { id: 'chord-cord', kind: 'sound-alike', words: [
      { w: 'chord', icon: '🎹', def: 'notes played together' },
      { w: 'cord', icon: '🔌', def: 'a thick string or cable' },
    ] },

    // ---------------------------------------------------------------
    // Look-alike: visually confusable spellings
    // ---------------------------------------------------------------
    { id: 'form-from', kind: 'look-alike', words: [
      { w: 'form', icon: '📋', def: 'a shape; a document' },
      { w: 'from', icon: '📤', def: 'starting at, out of' },
    ] },
    { id: 'through-thorough-though-thought-tough', kind: 'look-alike', words: [
      { w: 'through', icon: '🚇', def: 'in one side, out another' },
      { w: 'thorough', icon: '🔍', def: 'complete and careful' },
      { w: 'though', icon: '🤷', def: 'however, even if' },
      { w: 'thought', icon: '💭', def: 'an idea in your mind' },
      { w: 'tough', icon: '💪', def: 'strong or difficult' },
    ] },
    { id: 'quiet-quite-quit', kind: 'look-alike', words: [
      { w: 'quiet', icon: '🤫', def: 'making little noise' },
      { w: 'quite', icon: '✔️', def: 'very, or fairly' },
      { w: 'quit', icon: '🚪', def: 'to stop or leave' },
    ] },
    { id: 'trial-trail', kind: 'look-alike', words: [
      { w: 'trial', icon: '⚖️', def: 'a court case; a test' },
      { w: 'trail', icon: '🥾', def: 'a path; to follow behind' },
    ] },
    { id: 'angel-angle', kind: 'look-alike', words: [
      { w: 'angel', icon: '😇', def: 'a heavenly being' },
      { w: 'angle', icon: '📐', def: 'space between two meeting lines' },
    ] },
    { id: 'casual-causal', kind: 'look-alike', words: [
      { w: 'casual', icon: '👕', def: 'relaxed, not formal' },
      { w: 'causal', icon: '🔗', def: 'making something happen' },
    ] },
    { id: 'united-untied', kind: 'look-alike', words: [
      { w: 'united', icon: '🤝', def: 'joined together' },
      { w: 'untied', icon: '👟', def: 'not fastened, knot undone' },
    ] },
    { id: 'conservation-conversation', kind: 'look-alike', words: [
      { w: 'conservation', icon: '🌳', def: 'protecting nature and resources' },
      { w: 'conversation', icon: '💬', def: 'a talk between people' },
    ] },
    { id: 'diary-dairy', kind: 'look-alike', words: [
      { w: 'diary', icon: '📔', def: 'a daily personal journal' },
      { w: 'dairy', icon: '🥛', def: 'milk products' },
    ] },
    { id: 'lose-loose', kind: 'look-alike', words: [
      { w: 'lose', icon: '😞', def: 'to misplace or not win' },
      { w: 'loose', icon: '🧶', def: 'not tight or fixed' },
    ] },
    { id: 'adapt-adopt', kind: 'look-alike', words: [
      { w: 'adapt', icon: '🦎', def: 'to change to fit' },
      { w: 'adopt', icon: '👶', def: 'to take as your own' },
    ] },
    { id: 'imply-infer', kind: 'look-alike', words: [
      { w: 'imply', icon: '💭', def: 'to hint without saying' },
      { w: 'infer', icon: '🔍', def: 'to conclude from clues' },
    ] },
    { id: 'later-latter', kind: 'look-alike', words: [
      { w: 'later', icon: '⏳', def: 'after some time' },
      { w: 'latter', icon: '🔚', def: 'the second of two' },
    ] },
    { id: 'moral-morale', kind: 'look-alike', words: [
      { w: 'moral', icon: '😇', def: 'about right and wrong' },
      { w: 'morale', icon: '💪', def: "a group's confidence, spirit" },
    ] },
    { id: 'personal-personnel', kind: 'look-alike', words: [
      { w: 'personal', icon: '🔒', def: 'private, about one person' },
      { w: 'personnel', icon: '👥', def: 'the staff, employees' },
    ] },
    { id: 'climactic-climatic', kind: 'look-alike', words: [
      { w: 'climactic', icon: '🎬', def: 'at the most exciting point' },
      { w: 'climatic', icon: '🌡️', def: 'about long-term weather patterns' },
    ] },
    { id: 'conscience-conscious', kind: 'look-alike', words: [
      { w: 'conscience', icon: '😇', def: 'inner sense of right, wrong' },
      { w: 'conscious', icon: '👁️', def: 'awake and aware' },
    ] },
    { id: 'envelop-envelope', kind: 'look-alike', words: [
      { w: 'envelop', icon: '🌫️', def: 'to wrap or surround' },
      { w: 'envelope', icon: '✉️', def: 'a paper cover for letters' },
    ] },
    { id: 'lightning-lightening', kind: 'look-alike', words: [
      { w: 'lightning', icon: '⚡', def: 'flash in a storm' },
      { w: 'lightening', icon: '🎈', def: 'making less heavy or dark' },
    ] },
    { id: 'loath-loathe', kind: 'look-alike', words: [
      { w: 'loath', icon: '🙅', def: 'unwilling, reluctant' },
      { w: 'loathe', icon: '🤢', def: 'to hate strongly' },
    ] },
    { id: 'median-medium', kind: 'look-alike', words: [
      { w: 'median', icon: '➗', def: 'the middle value' },
      { w: 'medium', icon: '👕', def: 'average size, or a method' },
    ] },
    { id: 'prescribe-proscribe', kind: 'look-alike', words: [
      { w: 'prescribe', icon: '💊', def: 'to order as treatment' },
      { w: 'proscribe', icon: '🚫', def: 'to forbid or ban' },
    ] },
    { id: 'respectfully-respectively', kind: 'look-alike', words: [
      { w: 'respectfully', icon: '🙏', def: 'with politeness and honor' },
      { w: 'respectively', icon: '🔢', def: 'in the order given' },
    ] },
    { id: 'tenant-tenet', kind: 'look-alike', words: [
      { w: 'tenant', icon: '🏠', def: 'a person who rents' },
      { w: 'tenet', icon: '📜', def: 'a core belief' },
    ] },
    { id: 'breath-breathe', kind: 'look-alike', words: [
      { w: 'breath', icon: '💨', def: 'air taken into lungs' },
      { w: 'breathe', icon: '👃', def: 'to take in air' },
    ] },
    { id: 'cloth-clothe-clothes', kind: 'look-alike', words: [
      { w: 'cloth', icon: '🧵', def: 'fabric, woven material' },
      { w: 'clothe', icon: '👔', def: 'to dress someone' },
      { w: 'clothes', icon: '👕', def: 'things you wear' },
    ] },
    { id: 'of-off', kind: 'look-alike', words: [
      { w: 'of', icon: '🔗', def: 'belonging to; made from' },
      { w: 'off', icon: '📴', def: 'not on; away from' },
    ] },
    { id: 'human-humane', kind: 'look-alike', words: [
      { w: 'human', icon: '🧍', def: 'a person, like us' },
      { w: 'humane', icon: '❤️', def: 'kind and caring' },
    ] },
    { id: 'precedent-president', kind: 'look-alike', words: [
      { w: 'precedent', icon: '⚖️', def: 'an earlier example to follow' },
      { w: 'president', icon: '🏛️', def: 'the elected leader' },
    ] },
    { id: 'proof-prove', kind: 'look-alike', words: [
      { w: 'proof', icon: '📄', def: 'evidence that shows truth (noun)' },
      { w: 'prove', icon: '✅', def: 'to show something is true' },
    ] },
    { id: 'wander-wonder', kind: 'look-alike', words: [
      { w: 'wander', icon: '🚶', def: 'to walk without aim' },
      { w: 'wonder', icon: '✨', def: 'to be curious; amazement' },
    ] },
    { id: 'perspective-prospective', kind: 'look-alike', words: [
      { w: 'perspective', icon: '👓', def: 'a point of view' },
      { w: 'prospective', icon: '🔭', def: 'likely in the future' },
    ] },
    { id: 'persecute-prosecute', kind: 'look-alike', words: [
      { w: 'persecute', icon: '⛓️', def: 'to treat cruelly, unfairly' },
      { w: 'prosecute', icon: '⚖️', def: 'to charge in court' },
    ] },
    { id: 'statue-statute-stature', kind: 'look-alike', words: [
      { w: 'statue', icon: '🗽', def: 'a carved figure' },
      { w: 'statute', icon: '📜', def: 'a written law' },
      { w: 'stature', icon: '📏', def: 'height or reputation' },
    ] },
    { id: 'martial-marital', kind: 'look-alike', words: [
      { w: 'martial', icon: '🥋', def: 'about war or fighting' },
      { w: 'marital', icon: '💍', def: 'about marriage' },
    ] },
    { id: 'sacred-scared', kind: 'look-alike', words: [
      { w: 'sacred', icon: '🙏', def: 'holy, deeply respected' },
      { w: 'scared', icon: '😱', def: 'afraid, frightened' },
    ] },
    { id: 'dose-does', kind: 'look-alike', words: [
      { w: 'dose', icon: '💊', def: 'an amount of medicine' },
      { w: 'does', icon: '✔️', def: 'performs an action' },
    ] },
    { id: 'county-country', kind: 'look-alike', words: [
      { w: 'county', icon: '🗺️', def: 'a local government area' },
      { w: 'country', icon: '🌍', def: 'a nation' },
    ] },
    { id: 'beside-besides', kind: 'look-alike', words: [
      { w: 'beside', icon: '👫', def: 'next to' },
      { w: 'besides', icon: '➕', def: 'in addition to' },
    ] },
    { id: 'ethic-ethnic', kind: 'look-alike', words: [
      { w: 'ethic', icon: '⚖️', def: 'a moral belief or rule' },
      { w: 'ethnic', icon: '🌍', def: 'about cultural background or heritage' },
    ] },
    { id: 'simulate-stimulate', kind: 'look-alike', words: [
      { w: 'simulate', icon: '🖥️', def: 'to imitate or model' },
      { w: 'stimulate', icon: '⚡', def: 'to excite or energize' },
    ] },
    { id: 'collage-college', kind: 'look-alike', words: [
      { w: 'collage', icon: '🖼️', def: 'art from glued pieces' },
      { w: 'college', icon: '🎓', def: 'school after high school' },
    ] },
    { id: 'tired-tried', kind: 'look-alike', words: [
      { w: 'tired', icon: '😴', def: 'needing rest or sleep' },
      { w: 'tried', icon: '💪', def: 'made an attempt' },
    ] },
    { id: 'filed-field', kind: 'look-alike', words: [
      { w: 'filed', icon: '🗂️', def: 'put away in order' },
      { w: 'field', icon: '🌾', def: 'open land; a subject area' },
    ] },
    { id: 'who-how', kind: 'look-alike', words: [
      { w: 'who', icon: '🙋', def: 'what person' },
      { w: 'how', icon: '🛠️', def: 'in what way' },
    ] },
    { id: 'was-saw', kind: 'look-alike', words: [
      { w: 'was', icon: '⏪', def: 'past form of is' },
      { w: 'saw', icon: '👀', def: 'viewed, in the past' },
    ] },
    { id: 'left-felt', kind: 'look-alike', words: [
      { w: 'left', icon: '⬅️', def: 'opposite of right; departed' },
      { w: 'felt', icon: '💓', def: 'sensed an emotion or touch' },
    ] },
    { id: 'own-won-now', kind: 'look-alike', words: [
      { w: 'own', icon: '🏠', def: 'to have as yours' },
      { w: 'won', icon: '🏆', def: 'came first, gained victory' },
      { w: 'now', icon: '⏱️', def: 'at this moment' },
    ] },
    { id: 'being-begin', kind: 'look-alike', words: [
      { w: 'being', icon: '🧍', def: 'existing; a living creature' },
      { w: 'begin', icon: '🏁', def: 'to start' },
    ] },
    { id: 'unclear-nuclear', kind: 'look-alike', words: [
      { w: 'unclear', icon: '🌫️', def: 'not easy to understand' },
      { w: 'nuclear', icon: '⚛️', def: 'about atoms or atomic energy' },
    ] },
    { id: 'reserve-reverse', kind: 'look-alike', words: [
      { w: 'reserve', icon: '📅', def: 'to book or keep back' },
      { w: 'reverse', icon: '↩️', def: 'to go backward; the opposite' },
    ] },
    { id: 'brought-bought', kind: 'look-alike', words: [
      { w: 'brought', icon: '🚚', def: 'carried here, from bring' },
      { w: 'bought', icon: '🛍️', def: 'paid for, from buy' },
    ] },
    { id: 'adverse-averse', kind: 'look-alike', words: [
      { w: 'adverse', icon: '⛈️', def: 'harmful or unfavorable' },
      { w: 'averse', icon: '🙅', def: 'strongly opposed to' },
    ] },
    { id: 'sense-since', kind: 'look-alike', words: [
      { w: 'sense', icon: '👃', def: 'a feeling; meaning' },
      { w: 'since', icon: '📆', def: 'from then until now; because' },
    ] },
    { id: 'rational-rationale', kind: 'look-alike', words: [
      { w: 'rational', icon: '🧠', def: 'based on reason, sensible' },
      { w: 'rationale', icon: '📝', def: 'the reasons behind a choice' },
    ] },
    { id: 'wary-weary', kind: 'look-alike', words: [
      { w: 'wary', icon: '👀', def: 'cautious, on guard' },
      { w: 'weary', icon: '😩', def: 'very tired' },
    ] },
    { id: 'conform-confirm', kind: 'look-alike', words: [
      { w: 'conform', icon: '🐑', def: 'to follow rules or norms' },
      { w: 'confirm', icon: '✅', def: 'to check it is true' },
    ] },
    { id: 'contract-contact', kind: 'look-alike', words: [
      { w: 'contract', icon: '📜', def: 'a legal agreement; to shrink' },
      { w: 'contact', icon: '📞', def: 'to reach someone; touch' },
    ] },
    { id: 'abroad-aboard', kind: 'look-alike', words: [
      { w: 'abroad', icon: '🌍', def: 'in a foreign country' },
      { w: 'aboard', icon: '🚢', def: 'on a ship or plane' },
    ] },
    { id: 'signal-single', kind: 'look-alike', words: [
      { w: 'signal', icon: '🚦', def: 'a sign or message' },
      { w: 'single', icon: '1️⃣', def: 'only one; not married' },
    ] },
    { id: 'liable-libel', kind: 'look-alike', words: [
      { w: 'liable', icon: '⚠️', def: 'legally responsible; likely' },
      { w: 'libel', icon: '📰', def: 'a false, harmful written statement' },
    ] },
    { id: 'ingenious-ingenuous', kind: 'look-alike', words: [
      { w: 'ingenious', icon: '💡', def: 'very clever, inventive' },
      { w: 'ingenuous', icon: '😇', def: 'innocent and trusting' },
    ] },
    { id: 'appraise-apprise', kind: 'look-alike', words: [
      { w: 'appraise', icon: '💎', def: 'to judge the value' },
      { w: 'apprise', icon: '📢', def: 'to inform or tell' },
    ] },
  ];

  // lowercase word -> group object
  LL.HomophoneIndex = new Map();
  for (const group of LL.HOMOPHONES) {
    for (const entry of group.words) {
      LL.HomophoneIndex.set(entry.w.toLowerCase(), group);
    }
  }

  /**
   * Find the confusion group for a word.
   * Case-insensitive. Curly apostrophes are treated as straight ones.
   * @param {string} word
   * @returns {object|null} the group, or null when the word is not listed
   */
  LL.lookupHomophone = function (word) {
    if (typeof word !== 'string') return null;
    const key = word
      .replace(/[‘’ʼ′＇]/g, "'")
      .trim()
      .toLowerCase();
    if (!key) return null;
    return LL.HomophoneIndex.get(key) || null;
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { HOMOPHONES: LL.HOMOPHONES, lookupHomophone: LL.lookupHomophone };
  }
})();
