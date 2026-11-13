/*
 * LexiLens — English syllable splitter.
 *
 * Rule-based, no dictionary download, runs in well under a millisecond per
 * word. Used by the syllable tooltip to show a long word as readable chunks.
 *
 * The pipeline for one word:
 *   1. Apostrophes ("didn't", "they're") are peeled off and re-attached.
 *   2. A small exceptions table answers irregular and high-value academic
 *      words directly ("business", "epistemology").
 *   3. Otherwise: mark which letters are vowel sounds (y, qu, gu, silent e,
 *      -ed, -es, consonant + le), split neighbouring vowels that belong to
 *      different syllables (cre·ate, sci·ence), then place each boundary
 *      inside the consonants between two vowel sounds (digraphs and blends
 *      stay together, doubled consonants split).
 *
 * Guarantee: split(word).join('') === word, always.
 */
(() => {
  'use strict';

  const LL = (globalThis.LexiLens = globalThis.LexiLens || {});

  /* ------------------------------------------------------------ exceptions */

  /* Hyphens mark the syllable breaks. Looked up in lower case. */
  const EXCEPTIONS = (
    'busi-ness busi-ness-es eve-ry eve-ry-one eve-ry-thing eve-ry-bod-y eve-ry-where eve-ry-day ' +
    'dif-fer-ent dif-fer-ence dif-fer-ences dif-fer-ent-ly in-ter-est in-ter-est-ing in-ter-est-ed ' +
    'peo-ple colo-nel wednes-day feb-ru-ar-y queue queues eye eyes aisle isle is-land is-lands ' +
    'hy-poth-e-sis hy-poth-e-ses a-nal-y-sis a-nal-y-ses syn-the-sis em-pha-sis the-sis the-ses ' +
    'so-ci-e-ty so-ci-e-ties var-i-a-ble var-i-a-bles ar-e-a ar-e-as i-de-a i-de-as i-de-al ' +
    'be-ing be-ings po-em po-ems po-et po-ets po-et-ry po-et-ic cre-ate cre-ates cre-at-ed cre-at-ing ' +
    'cre-a-tion cre-a-tive cre-a-tiv-i-ty cre-a-tor crea-ture crea-tures na-ive co-op-er-ate ' +
    'co-op-er-a-tion co-or-di-nate co-or-di-na-tion zo-ol-o-gy ' +
    'ar-gue ar-gued ar-gues ar-gu-ing ar-gu-ment ar-gu-ments am-big-u-ous am-bi-gu-i-ty jag-uar ' +
    'rec-i-pe sim-i-le ca-tas-tro-phe a-pos-tro-phe hy-per-bo-le e-pit-o-me ka-ra-te ca-fe ac-ne ' +
    'veg-e-ta-ble veg-e-ta-bles choc-o-late com-fort-a-ble un-com-fort-a-ble eve-ning fa-vor-ite ' +
    'res-tau-rant fam-i-ly fam-i-lies beau-ty beau-ti-ful mu-se-um nu-cle-us nu-cle-i nu-cle-ar ' +
    'de-i-ty a-the-ist a-the-ism the-o-ry the-o-ries the-o-ret-i-cal the-o-rem the-a-ter the-a-tre ' +
    'vid-e-o ra-di-o stu-di-o au-di-o pi-an-o vi-o-lin vi-o-lence vi-o-lent li-on ri-ot di-et qui-et ' +
    'qui-et-ly gi-ant cli-ent cli-ents di-al tri-al tri-als de-ni-al ma-te-ri-al ma-te-ri-als ' +
    'real real-ly re-al-i-ty re-al-ize re-al-ized re-al-is-tic re-al-ism o-cean does goes shoes ' +
    'ca-noe flu-id ru-in gen-u-ine cru-el fu-el du-al u-su-al u-su-al-ly ac-tu-al ac-tu-al-ly ' +
    'grad-u-al grad-u-al-ly man-u-al an-nu-al cas-u-al vis-u-al in-di-vid-u-al in-di-vid-u-als ' +
    'sit-u-a-tion sit-u-a-tions e-val-u-ate e-val-u-a-tion grad-u-ate per-suade per-sua-sive ' +
    'lan-guage lan-guag-es dis-tin-guish guar-an-tee pen-guin tongue league vague plague fa-tigue ' +
    'di-a-logue cat-a-logue u-nique tech-nique tech-niques an-tique rhy-thm rhy-thms hour hours our ' +
    'fire tired en-tire en-tire-ly i-ron law-yer may-or prayer lay-er play-er em-ploy-ee em-ploy-er ' +
    'roy-al loy-al voy-age be-yond can-yon na-ked wick-ed be-lov-ed sa-cred ha-tred hun-dred ' +
    'hun-dreds kin-dred once one ones done gone none some come comes be-come be-comes out-come ' +
    'in-come wel-come some-times some-thing some-one some-what some-where an-y-one an-y-thing ' +
    'there-fore be-fore more-o-ver how-ev-er when-ev-er what-ev-er wher-ev-er for-ev-er to-geth-er ' +
    'an-oth-er oth-er oth-ers moth-er broth-er fa-ther rath-er wheth-er weath-er ei-ther nei-ther ' +
    'clothes thor-ough thor-ough-ly e-nough daugh-ter neigh-bor ' +
    'ex-pe-ri-ence ex-pe-ri-enc-es ex-per-i-ment ex-per-i-ments ex-per-i-men-tal pe-ri-od pe-ri-ods ' +
    'se-ri-ous var-i-ous pre-vi-ous ob-vi-ous ob-vi-ous-ly cu-ri-ous fa-mil-iar pe-cul-iar sim-i-lar ' +
    'par-tic-u-lar par-tic-u-lar-ly reg-u-lar pop-u-lar es-pe-cial-ly spe-cial i-ni-tial i-ni-tial-ly ' +
    'es-sen-tial po-ten-tial ap-pre-ci-ate as-so-ci-ate as-so-ci-a-tion pro-nun-ci-a-tion ' +
    'ne-go-ti-ate par-lia-ment mar-riage car-riage chris-tian ques-tion ques-tions sug-ges-tion ' +
    'on-ion un-ion o-pin-ion o-pin-ions com-pan-ion mil-lion bil-lion bril-liant i-tal-ian sen-ior ' +
    'jun-ior be-hav-ior be-hav-iour cal-i-for-nia pneu-mo-nia ' +
    'psy-chol-o-gy psy-cho-log-i-cal e-pis-te-mol-o-gy e-pis-te-mo-log-i-cal meth-od-ol-o-gy ' +
    'tech-nol-o-gy bi-ol-o-gy bi-o-log-i-cal phi-los-o-phy phi-los-o-pher phi-los-o-phers ' +
    'phil-o-soph-i-cal pho-to-syn-the-sis phe-nom-e-non phe-nom-e-na char-ac-ter char-ac-ters ' +
    'char-ac-ter-is-tic char-ac-ter-is-tics bib-li-og-ra-phy ge-og-ra-phy bi-og-ra-phy de-moc-ra-cy ' +
    'e-con-o-my ec-o-nom-ic ec-o-nom-ics u-ni-ver-si-ty u-ni-ver-si-ties u-ni-verse u-ni-ver-sal ' +
    'lit-er-a-ture tem-per-a-ture en-vi-ron-ment en-vi-ron-men-tal gov-ern-ment de-vel-op-ment ' +
    'def-i-nite def-i-nite-ly nec-es-sar-y nec-es-sar-i-ly vo-cab-u-lar-y dic-tion-ar-y li-brar-y ' +
    'sec-re-tar-y cat-e-go-ry lab-o-ra-to-ry lab-o-ra-to-ries his-to-ry mem-o-ry sig-nif-i-cant ' +
    'sig-nif-i-cance com-mu-ni-cate com-mu-ni-ca-tion com-mu-ni-ty op-por-tu-ni-ty ' +
    're-spon-si-ble re-spon-si-bil-i-ty a-bil-i-ty ac-tiv-i-ty or-gan-ize or-gan-i-za-tion ' +
    'ap-prox-i-mate ap-prox-i-mate-ly im-me-di-ate im-me-di-ate-ly ap-pro-pri-ate sep-a-rate ' +
    'ac-cu-rate ad-e-quate es-ti-mate in-ter-dis-ci-pli-nar-y dis-ci-pline mis-un-der-stand-ing ' +
    'un-der-stand un-der-stand-ing knowl-edge ac-knowl-edge col-lege av-er-age jus-ti-fi-ca-tion ' +
    'fal-si-fi-ca-tion sci-ence sci-enc-es sci-en-tif-ic sci-en-tist sci-en-tists med-i-cine ' +
    'el-e-ment el-e-ments el-e-men-ta-ry in-cre-ment ob-ser-va-tion ob-ser-va-tions ' +
    'em-pir-i-cal par-a-digm par-a-graph pseu-do-sci-ence a-nom-a-ly a-nom-a-lies ' +
    'the-o-ries hy-poth-e-size sta-tis-tics sta-tis-ti-cian prob-a-bil-i-ty'
  ).split(' ');

  const EXCEPTION_MAP = new Map();
  for (const entry of EXCEPTIONS) EXCEPTION_MAP.set(entry.replace(/-/g, ''), entry);

  /* Words where n't adds no syllable. */
  const NT_ONE_SYLLABLE = new Set(['don', 'can', 'won', 'aren', 'weren', 'ain', 'shan']);

  /* Stems after a prefix where the two vowels are separate syllables
     (re·act, pre·exist, co·exist). Everything else keeps the vowel team
     (read, preach, coat). */
  const PREFIX_HIATUS = [
    ['re', /^(act|adjust|admit|affirm|align|allocat|analy|appear|appl|appoint|apprais|arrang|assembl|assert|assess|assign|assur|attach|educat|elect|emerg|enact|enforc|engag|enter|establish|evaluat|examin|imburs|incarnat|inforc|install|instat|integrat|interpret|introduc|invent|invest|iterat|open|order|organi|orient|unit|unif|upload|us(e|ed|es|ing|able)$)/],
    ['pre', /^(empt|exist|eminent|amble|arrang|occup|install|order|approv)/],
    ['de', /^(activat|escalat|emphasi|odor|oxid)/],
    ['co', /^(operat|ordinat|exist|author|incid|efficient|educat|alition|agulat)/],
    ['pro', /^(act)/],
    ['geo', /^(graph|log|met|polit|therm|phys|centr|sci)/],
  ];
  const OPEN_PREFIXES = ['anti', 'semi', 'multi', 'micro', 'macro', 'extra', 'intra', 'ultra', 'hydro', 'electro', 'neo', 'bio'];

  /* Second halves of compounds whose first half ends in a silent e. */
  const SILENT_E_TAIL = /^(.{2,}[^aeiouy]e)(ly|ment|ments|ness|less|ful|fully|ty|times|time|thing|things|one|where|how|what|body|day|days|work|works|land|made|style|long|line|lines|table|ball|walk|place|book|books|wise|guard|board|side|room|mate|way|ways|point|back|like|ship|hood|man|men|ward|wards)$/;

  const VOWELS = 'aeiou';
  const isVowelLetter = (ch) => VOWELS.includes(ch);

  /* Consonant letters that travel together. */
  const TRIGRAPHS = ['tch', 'sch'];
  const DIGRAPHS = ['ch', 'sh', 'th', 'ph', 'wh', 'gh', 'ck', 'qu', 'gu'];
  /* Clusters that may begin a syllable after a split. */
  const ONSETS3 = new Set(['str', 'spr', 'scr', 'spl', 'squ', 'thr', 'shr', 'chr', 'phr', 'schr']);
  const LR_FIRST = new Set(['b', 'c', 'd', 'f', 'g', 'k', 'p', 't', 'th', 'sh', 'ch', 'ph']);
  const S_BLENDS = new Set(['sc', 'sk', 'sl', 'sm', 'sn', 'sp', 'st', 'sw', 'squ', 'tw', 'dw']);
  /* Consonants before a final "le" that make it its own syllable (ta·ble). */
  const SYLLABIC_LE = 'bcdfgkpstz';

  /* ------------------------------------------------------------- vowel map */

  /**
   * For each letter: true when it is (part of) a vowel sound.
   * Handles y, qu / gu, and the silent e family.
   */
  function vowelMap(w) {
    const n = w.length;
    const v = new Array(n).fill(false);

    for (let i = 0; i < n; i += 1) {
      const ch = w[i];
      if (isVowelLetter(ch)) v[i] = true;
      else if (ch === 'y') {
        const prev = w[i - 1] || '';
        const next = w[i + 1] || '';
        const nextIsVowel = isVowelLetter(next);
        // y is a consonant at the start of a word or between vowel sounds
        // (yes, be·yond, law·yer); otherwise it is a vowel (gym, hap·py).
        const consonant = nextIsVowel && (i === 0 || isVowelLetter(prev) || prev === 'w');
        v[i] = !consonant;
      }
    }

    // qu: the u is part of the consonant sound. Same for gu before a vowel in
    // words like guess, guide, language, vague.
    for (let i = 1; i < n - 1; i += 1) {
      if (w[i] !== 'u' || !isVowelLetter(w[i + 1])) continue;
      if (w[i - 1] === 'q') v[i] = false;
      else if (w[i - 1] === 'g' && (i === 1 || w[i - 2] === 'n' || w[i + 1] === 'e' || w[i + 1] === 'i')) v[i] = false;
    }

    const others = (skip) => v.some((on, i) => on && !skip.includes(i));
    const soundBefore = (i) => (v[i - 1] ? 'vowel' : 'consonant');

    // Final e: silent after a consonant (make), unless it is the only vowel
    // (the, be) or follows consonant + l (ta·ble).
    const silentFinalE = (i) => {
      if (w[i] !== 'e' || !others([i])) return false;
      if (soundBefore(i) === 'vowel') return false; // part of a team: tree, blue
      if (w[i - 1] === 'l' && i >= 2 && SYLLABIC_LE.includes(w[i - 2])) return false;
      return true;
    };

    if (n >= 2 && silentFinalE(n - 1)) v[n - 1] = false;

    // -es: voiced only after a hissing sound (box·es, chang·es) or
    // consonant + l (ta·bles); otherwise the e is silent (makes).
    if (n > 3 && w.endsWith('es') && v[n - 2] && soundBefore(n - 2) === 'consonant') {
      const stem = w.slice(0, n - 2);
      const hissing = /(s|x|z|ch|sh|c|g)$/.test(stem);
      const syllabicLe = /[bcdfgkpstz]l$/.test(stem);
      if (!hissing && !syllabicLe && others([n - 2])) v[n - 2] = false;
    }

    // -ed: voiced only after t or d (want·ed, add·ed) or consonant + l
    // (han·dled); otherwise silent (walked, played).
    if (n > 3 && w.endsWith('ed') && v[n - 2] && soundBefore(n - 2) === 'consonant') {
      const stem = w.slice(0, n - 2);
      const voiced = /[td]$/.test(stem) || /[bcdfgkpstz]l$/.test(stem);
      if (!voiced && others([n - 2])) v[n - 2] = false;
    }

    return v;
  }

  /* ---------------------------------------------------------------- hiatus */

  /**
   * Two vowel letters sit side by side at i and i + 1. Do they belong to
   * different syllables (cre|ate) or form one sound (boat)?
   */
  function breaksBetween(w, i) {
    const a = w[i];
    const b = w[i + 1];
    const before = w.slice(0, i);
    const after = w.slice(i + 2);

    // Prefix boundaries: re|act, pre|exist, co|operate, anti|oxidant.
    for (const [prefix, stems] of PREFIX_HIATUS) {
      if (i === prefix.length - 1 && w.startsWith(prefix) && stems.test(w.slice(prefix.length))) return true;
    }
    for (const prefix of OPEN_PREFIXES) {
      if (i === prefix.length - 1 && w.startsWith(prefix) && w.length > prefix.length + 2) return true;
    }

    // A vowel followed by -ing: be|ing, do|ing, stud·y|ing.
    if (b === 'i' && /^ng(s|ly)?$/.test(after)) return true;

    if (a === 'y') return !(b === 'e' && /^[sd]?$/.test(after)); // dry|er, but dye, eyes

    switch (a + b) {
      case 'ia':
        if (/[ct]$/.test(before) && /^[ln]/.test(after)) return false; // spe·cial, mu·si·cian
        if (/ll$|ss$/.test(before)) return false;                      // bril·liant, Rus·sia
        if (/^ge[sd]?$/.test(after)) return false;                     // mar·riage
        if (/l$/.test(before) && /^ns?$/.test(after)) return false;    // I·tal·ian
        return true;                                                   // me·di·a, di·a·gram
      case 'io':
        if (/[tscxg]$/.test(before) && /^n/.test(after)) return false;  // na·tion, re·gion
        if (/[ctgx]$/.test(before) && /^us/.test(after)) return false;  // de·li·cious
        if (/n$/.test(before) && /^ns?$/.test(after)) return false;     // o·pin·ion
        if (/ll$/.test(before)) return false;                           // mil·lion
        if (/[nv]$/.test(before) && /^rs?$/.test(after)) return false;  // sen·ior
        return true;                                                    // ra·di·o, pe·ri·od
      case 'iu':
        return true;                                                    // me·di·um
      case 'ie':
        if (before === 'sc') return true;                               // sci·ence
        if (/^ty/.test(after)) return true;                             // va·ri·e·ty
        if (/^(nce|nt|ncy)/.test(after)) return !/[ct]$/.test(before);  // au·di·ence, not pa·tient
        if (/^t(s|ly|ary)?$/.test(after)) return true;                  // di·et, qui·et
        if (after === 'r' && before.length >= 3 && !/(sold|cash|front|prem)$/.test(before)) return true; // eas·i·er
        if (after === 'st' && before.length >= 3) return true;          // hap·pi·est
        return false;                                                   // field, stud·ied
      case 'ea':
        if (/cr$/.test(before) && /^t(e|ed|es|ing|ion|ions|ive|or|ors)$/.test(after)) return true; // cre·ate
        if (before === 'r' && /^(ct|li)/.test(after)) return true;      // re·act, re·al·i·ty
        if (/th$/.test(before) && /^t/.test(after)) return true;        // the·a·ter
        if (/(cl|lin)$/.test(before) && /^r/.test(after)) return true;  // nu·cle·ar, lin·e·ar
        return false;                                                   // read, teach
      case 'eo':
        return !(/g$/.test(before) && /^(us|n)/.test(after));           // vid·e·o, not gor·geous
      case 'eu':
        return /^[ms]$/.test(after) && before.length >= 2;              // mu·se·um, nu·cle·us
      case 'ua':
        return !(/s$/.test(before) && /^(de|sion|sive)/.test(after));   // ac·tu·al, not per·suade
      case 'ue':
        return !/^[sd]?$/.test(after);                                  // flu·ent, not blue / blues
      case 'ui':
        return /^(ty|tion|tive|n|d|sm)/.test(after);                    // in·tu·i·tion, ru·in, flu·id
      case 'uo':
      case 'uu':
      case 'ao':
      case 'ii':
        return true;                                                    // du·o, cha·os, ski·ing
      case 'oa':
        return before === '';                                           // o·a·sis
      case 'oe':
        return before === 'p';                                          // po·em
      case 'oi':
        return /^c(s|al|ally)?$/.test(after) && before.length >= 2;     // he·ro·ic
      case 'ai':
        return /^c(s|al)?$/.test(after);                                // ar·cha·ic
      default:
        return false;                                                   // ee, oo, ou, au, ei ...
    }
  }

  /* ------------------------------------------------------------ boundaries */

  /** Split a run of consonant letters into units (digraphs stay whole). */
  function consonantUnits(cluster) {
    const units = [];
    let i = 0;
    while (i < cluster.length) {
      const three = cluster.slice(i, i + 3);
      const two = cluster.slice(i, i + 2);
      if (TRIGRAPHS.includes(three)) { units.push(three); i += 3; }
      else if (DIGRAPHS.includes(two)) { units.push(two); i += 2; }
      else { units.push(cluster[i]); i += 1; }
    }
    return units;
  }

  /**
   * How many letters of the consonant cluster stay with the syllable on the
   * left. `w` and the cluster position give context for a few suffix rules.
   */
  function leftShare(w, start, end, nucleusCount) {
    const cluster = w.slice(start, end);
    const units = consonantUnits(cluster);
    const lengthOf = (count) => units.slice(0, count).join('').length;
    const prev = w[start - 1] || '';
    const rest = w.slice(end);

    if (units.length === 1) {
      const unit = units[0];
      if (unit === 'x' || unit === 'ck' || unit === 'tch') return cluster.length; // ex·am, pock·et
      if (unit === 'w') {
        // ow / aw / ew teams keep their w: pow·er, draw·ing (but a·way, re·ward).
        const team = prev === 'o' || (prev === 'a' && start >= 2) ||
          (prev === 'e' && start >= 2 && !/^(re|be|de|pre)w/.test(w));
        return team ? 1 : 0;
      }
      // -ology, -onomy, -ometer: the consonant closes the stressed syllable.
      if (prev === 'o' && /^(l(og)|n(om)|m(et(er|ry|ric)))/.test(cluster + rest)) return cluster.length;
      // -ity / -ic(al): ac·tiv·i·ty, spe·cif·ic (but com·mu·ni·ty, mu·sic).
      if (prev !== 'u' && start >= 2 && nucleusCount >= 3 &&
        (/^(ity|ities|ic|ics|ical|ically)$/.test(rest) || /^i[fl]y$/.test(rest))) return cluster.length;
      return 0; // pa·per
    }

    // -ography: ge·og·ra·phy.
    if (prev === 'o' && cluster === 'gr' && /^aph/.test(rest)) return 1;

    if (units.length === 2) {
      const [first, second] = units;
      const blend = (second === 'l' || second === 'r') && LR_FIRST.has(first) && first !== second;
      return blend ? 0 : lengthOf(1); // se·cret, but bas·ket and let·ter
    }

    // Three or more: keep the longest cluster that can start a syllable.
    const lastThree = units.slice(-3).join('');
    const lastTwo = units.slice(-2).join('');
    if (ONSETS3.has(lastThree)) return lengthOf(units.length - 3);
    if (ONSETS3.has(lastTwo)) return lengthOf(units.length - 2);
    const [u1, u2] = units.slice(-2);
    const blend = ((u2 === 'l' || u2 === 'r') && LR_FIRST.has(u1) && u1 !== u2) || S_BLENDS.has(lastTwo);
    return blend ? lengthOf(units.length - 2) : lengthOf(units.length - 1); // in·struct, pump·kin
  }

  /** Indexes where a new syllable starts (excluding 0). */
  function boundaries(w) {
    const v = vowelMap(w);
    const n = w.length;

    // Vowel-sound groups, with hiatus splits inside runs of vowel letters.
    const nuclei = []; // [start, end)
    let i = 0;
    while (i < n) {
      if (!v[i]) { i += 1; continue; }
      let start = i;
      while (i + 1 < n && v[i + 1]) {
        if (breaksBetween(w, i)) { nuclei.push([start, i + 1]); start = i + 1; }
        i += 1;
      }
      nuclei.push([start, i + 1]);
      i += 1;
    }
    if (nuclei.length < 2) return [];

    const cuts = [];
    for (let k = 0; k < nuclei.length - 1; k += 1) {
      const gapStart = nuclei[k][1];
      const gapEnd = nuclei[k + 1][0];
      if (gapStart === gapEnd) cuts.push(gapStart);
      else cuts.push(gapStart + leftShare(w, gapStart, gapEnd, nuclei.length));
    }
    return cuts;
  }

  /* ----------------------------------------------------------------- split */

  function cutAt(word, cuts) {
    const parts = [];
    let from = 0;
    for (const cut of cuts) {
      if (cut > from && cut < word.length) { parts.push(word.slice(from, cut)); from = cut; }
    }
    parts.push(word.slice(from));
    return parts;
  }

  /** Split a word made only of letters. `w` is its lower-case form. */
  function splitLetters(word, w) {
    const known = EXCEPTION_MAP.get(w);
    if (known) {
      const cuts = [];
      let index = 0;
      for (const ch of known) {
        if (ch === '-') cuts.push(index);
        else index += 1;
      }
      return cutAt(word, cuts);
    }

    // love|ly, state|ment, some|thing: a silent e in the middle of the word.
    const tail = SILENT_E_TAIL.exec(w);
    if (tail) {
      const stem = tail[1];
      const stemVowels = vowelMap(stem);
      const silent = !stemVowels[stem.length - 1] && stemVowels.some(Boolean);
      if (silent) {
        const head = splitLetters(word.slice(0, stem.length), stem);
        const rest = word.slice(stem.length);
        const restLower = w.slice(stem.length);
        return head.concat(splitLetters(rest, restLower));
      }
    }

    return cutAt(word, boundaries(w));
  }

  const CACHE = new Map();
  const CACHE_LIMIT = 5000;
  const LETTERS_ONLY = /^\p{L}+$/u;
  const APOSTROPHE = /['’]/;

  /**
   * Split a word into syllable chunks.
   * @param {string} word
   * @returns {string[]} chunks that join back to exactly `word`
   */
  function split(word) {
    if (typeof word !== 'string' || word === '') return word === '' ? [] : [String(word)];
    const cached = CACHE.get(word);
    if (cached) return cached.slice();

    let parts;
    try {
      parts = splitUncached(word);
      if (parts.join('') !== word || parts.some((p) => p === '')) parts = [word];
    } catch (_) {
      parts = [word];
    }

    if (CACHE.size >= CACHE_LIMIT) CACHE.delete(CACHE.keys().next().value);
    CACHE.set(word, parts);
    return parts.slice();
  }

  function splitUncached(word) {
    const w = word.toLowerCase();
    if (w.length !== word.length) return [word]; // exotic case mapping: do not risk it

    const mark = w.search(APOSTROPHE);
    if (mark === -1) return LETTERS_ONLY.test(w) ? splitLetters(word, w) : [word];

    // Contractions and possessives.
    const base = w.slice(0, mark);
    const tail = w.slice(mark + 1);
    if (!base || !LETTERS_ONLY.test(base) || (tail && !LETTERS_ONLY.test(tail))) return [word];

    if (tail === 't' && base.endsWith('n')) {
      if (NT_ONE_SYLLABLE.has(base)) return [word];             // don't, can't
      const stem = base.slice(0, -1);
      if (!stem) return [word];
      const head = splitLetters(word.slice(0, stem.length), stem);
      return head.concat(word.slice(stem.length));               // did·n't
    }
    const head = splitLetters(word.slice(0, mark), base);
    head[head.length - 1] += word.slice(mark);                   // they're, student's
    return head;
  }

  function count(word) {
    return split(word).length;
  }

  LL.Syllables = { split, count };
  if (typeof module !== 'undefined' && module.exports) module.exports = LL.Syllables;
})();
