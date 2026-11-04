// English names for the card and films. Part names in src/lego.js are Russian (ru); this maps them
// word by word (the catalogue uses a small fixed vocabulary). Unknown words are kept as they are.
'use strict';

const PHRASES = [
  ['Техник-балка', 'Technic beam'], ['Техник-штифт', 'Technic pin'], ['Техник-кирпич', 'Technic brick'],
  ['Техник-соединитель', 'Technic connector'], ['Каркас-кабина', 'cab frame'], ['Тарелка-антенна', 'radar dish'],
  ['Двойной обратный скос', 'inverted double slope'], ['Двойной скос', 'double slope'], ['Изогнутый скос', 'curved slope'],
  ['Клиновидная пластина', 'wedge plate'], ['Круглая пластина', 'round plate'], ['Круглая плитка', 'round tile'],
  ['Круглый кирпич', 'round brick'], ['Кирпич', 'brick'], ['Пластина', 'plate'], ['Плитка', 'tile'], ['Скос', 'slope'],
  ['Кронштейн', 'bracket'], ['Конус', 'cone'], ['Ящик', 'container'], ['Лестница', 'ladder'], ['Пламя', 'flame'],
  ['Колесо с шиной', 'wheel with tyre'], ['Колёсико с шиной', 'small wheel with tyre'], ['Ручка (аксессуар)', 'handle (accessory)'],
  ['с отверстиями', 'with holes'], ['с фиксатором', 'with friction'], ['с осью', 'with axle'], ['с шарами', 'with balls'],
  ['с рельсом', 'with rail'], ['с двумя зубцами', 'with two clips'], ['с шипом сбоку', 'with side stud'], ['с окном', 'with window'],
  ['с колёсами', 'with wheels'], ['скруглённая', 'rounded'],
];

function partEn(ru) {
  let s = String(ru || '');
  for (const [a, b] of PHRASES) s = s.split(a).join(b);
  s = s.trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const LANGS = ['ru', 'en'];
const pick = (lang) => (LANGS.includes(lang) ? lang : 'ru');

module.exports = { partEn, pick, LANGS };
