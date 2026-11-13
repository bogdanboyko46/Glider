/*
 * passages.js — one short, neutral, factual passage per age band, each with
 * two multiple-choice comprehension questions (correct = index into options).
 */
(function (root) {
  'use strict';

  const PASSAGES = {
    '8-10': {
      id: 'bees-8-10', title: 'Honeybees',
      text: 'Honeybees live together in a hive. Each hive has one queen, and she lays all of the eggs. Worker bees fly out to find flowers. They drink the sweet nectar and carry it home. Inside the hive, the bees turn the nectar into honey. They store it in small wax cells. In winter, when there are no flowers, the bees eat the honey to stay alive.',
      questions: [
        { q: 'Who lays all of the eggs in a hive?', options: ['The worker bees', 'The queen', 'The flowers'], correct: 1 },
        { q: 'Why do the bees store honey?', options: ['To eat it in winter', 'To feed the flowers', 'To build the hive'], correct: 0 },
      ],
    },
    '11-13': {
      id: 'volcano-11-13', title: 'How a volcano erupts',
      text: 'Deep under the ground, the Earth is hot enough to melt rock. This melted rock is called magma. It is lighter than the solid rock around it, so it slowly rises. Sometimes it collects in a large pool below a mountain. When the pressure grows too strong, the magma bursts out through an opening. Once it reaches the surface, it is called lava. As the lava cools, it hardens into new rock, and over many years the mountain grows taller.',
      questions: [
        { q: 'What is melted rock called while it is still underground?', options: ['Lava', 'Magma', 'Ash'], correct: 1 },
        { q: 'Why does magma rise?', options: ['It is lighter than the rock around it', 'The wind pushes it upward', 'It is colder than the rock around it'], correct: 0 },
      ],
    },
    '14-17': {
      id: 'tides-14-17', title: 'Why the sea has tides',
      text: 'The level of the sea rises and falls twice each day. These changes are called tides, and they are caused mainly by the Moon. The Moon’s gravity pulls on the Earth’s oceans, drawing the water toward it and creating a bulge. A second bulge forms on the opposite side of the planet. As the Earth turns, coastlines pass through both bulges, which produces two high tides and two low tides. The Sun also plays a part. When the Sun and Moon line up, their combined pull makes the tides stronger than usual.',
      questions: [
        { q: 'What is the main cause of tides?', options: ['Strong winds', 'The Moon’s gravity', 'Ocean currents'], correct: 1 },
        { q: 'When are tides stronger than usual?', options: ['When the Sun and Moon line up', 'During the winter', 'In the middle of the night'], correct: 0 },
      ],
    },
    adult: {
      id: 'paper-adult', title: 'The spread of paper',
      text: 'Paper was first made in China about two thousand years ago. Early papermakers soaked plant fibres, such as bark and old rags, in water until they became a soft pulp. They spread the pulp across a flat screen and let the water drain away. The thin layer left behind was pressed and dried in the sun to form a sheet. The method spread slowly along trade routes, reaching Europe more than a thousand years later. Before then, most European books were written on animal skin, which was costly and slow to prepare. Cheaper paper made it practical to print books in large numbers.',
      questions: [
        { q: 'What did early papermakers spread across a flat screen?', options: ['Ink', 'Pulp', 'Animal skin'], correct: 1 },
        { q: 'Why did paper make large-scale printing practical?', options: ['It was cheaper than animal skin', 'It was brighter than animal skin', 'It lasted longer than animal skin'], correct: 0 },
      ],
    },
  };

  const forBand = (band) => PASSAGES[band] || PASSAGES.adult;
  const byId = (id) => Object.values(PASSAGES).find((p) => p.id === id) || null;

  const api = { PASSAGES, forBand, byId };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RCPassages = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
