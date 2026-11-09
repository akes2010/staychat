// server/utils/fnb.js
// One classification of a menu item for food & drink ordering: the Halls &
// Events bill, the guest pre-order menu and the POS terminals must all agree
// on whether something is food or a drink, otherwise an event order can land
// on the wrong terminal.
'use strict';

const DRINK_CATEGORIES = [
  'drinks', 'drink', 'beverages', 'beverage', 'cocktails', 'cocktail', 'mocktails',
  'beer', 'beers', 'wine', 'wines', 'spirits', 'liquor', 'soft drinks', 'hot drinks',
];
const DRINK_NAME = /drink|cocktail|mocktail|beer|wine|spirit|liquor|juice|water|soda|smoothie|shake|coffee|tea|whisk|vodka|rum|gin|champagne|brandy|cognac|lemonade|sprite|coke|cola/i;

// 'drink' | 'food'. A bar-menu food item stays food here — its outlet routing
// is handled separately by fnbOutlet.
function fnbKind(item) {
  const category = String((item && item.category) || '').toLowerCase();
  if (DRINK_CATEGORIES.includes(category)) return 'drink';
  if (/food|meal|starter|main|dessert|snack|pastr|grill|rice|pizza|burger/i.test(category)) return 'food';
  return DRINK_NAME.test(String((item && item.name) || '')) ? 'drink' : 'food';
}

// Which POS terminal makes it: an item explicitly on the bar or restaurant
// menu goes there; a shared menu item follows its kind (food → kitchen,
// drinks → bar).
function fnbOutlet(item) {
  const outlet = String((item && item.outlet) || '').toLowerCase();
  if (outlet === 'bar' || outlet === 'restaurant') return outlet;
  return fnbKind(item) === 'drink' ? 'bar' : 'restaurant';
}

module.exports = { fnbKind, fnbOutlet };
