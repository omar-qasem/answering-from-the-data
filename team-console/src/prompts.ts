// The three prompts the graphs use, each with a strict JSON schema.

export const UNDERSTAND_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['intent', 'language', 'products', 'uses_post_product', 'pack', 'locations', 'stores', 'wants_price', 'short_reply', 'reason'],
  properties: {
    intent: { type: 'string', enum: ['availability', 'price', 'praise', 'complaint', 'other_question', 'tag_or_chat', 'spam'] },
    language: { type: 'string', enum: ['ar', 'en'] },
    products: { type: 'array', items: { type: 'string' } },
    uses_post_product: { type: 'boolean' },
    pack: { type: ['string', 'null'] },
    locations: { type: 'array', items: { type: 'string' } },
    stores: { type: 'array', items: { type: 'string' } },
    wants_price: { type: 'boolean' },
    short_reply: { type: ['string', 'null'] },
    reason: { type: 'string' },
  },
} as const;

export function understandPrompt(o: { caption: string; postProducts: string[]; name: string; comment: string; productHints: string[]; placeHints: string[] }) {
  const system = [
    "You read Instagram comments left under a Jordanian food brand's posts and extract what the customer wants. Answer with JSON only.",
    'intent:',
    '- "availability": asks where to find or buy a product, or whether it is available somewhere (an area, a city or a shop).',
    '- "price": only asks the price. If they ask where AND the price, use "availability" with wants_price true.',
    '- "praise": compliments or thanks, no question.',
    '- "complaint": a problem with quality, expiry, a shop or service (even if phrased as a question).',
    '- "other_question": any other question (ingredients, delivery, recipes, offers, jobs...).',
    '- "tag_or_chat": tagging friends, emojis or small talk that needs no answer.',
    '- "spam": ads, links or unrelated content.',
    'products: the product names the customer mentions, as they wrote them with obvious typos fixed (e.g. "زيت زيتوون" -> "زيت زيتون"). Never invent products. Empty if none.',
    'uses_post_product: true when they ask about the product shown in the post ("وين بلاقيه؟", "is this available?") or do not name another product.',
    'pack: a pack size or size word if mentioned ("1.8 كيلو", "الكبير", "900g"), else null.',
    'locations: areas, neighbourhoods, cities or regions they mention, typos fixed. Empty if none.',
    'stores: shop or supermarket names they mention. Empty if none.',
    'wants_price: true if they ask about the price.',
    'language: "ar" if the comment is mainly Arabic, otherwise "en".',
    'short_reply: only for praise, complaint and other_question. A warm reply of at most 30 words in the customer\'s language (friendly Jordanian dialect for Arabic). No promises about stock, prices, delivery or refunds. For a complaint, apologise and ask them to send a private message with the shop name and purchase date. null for every other intent.',
    'reason: one short English sentence explaining your reading.',
    `Known product names (use them to fix spelling, but keep what the customer meant): ${o.productHints.join('; ')}`,
    `Known places: ${o.placeHints.join('; ')}`,
  ].join('\n');
  const user = [`Post caption: ${o.caption || '(none)'}`, `Products in this post: ${o.postProducts.join('; ') || '(unknown)'}`, `Customer name: ${o.name || '(unknown)'}`, `Comment: ${o.comment}`].join('\n');
  return { system, user };
}

export const COMPOSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply'],
  properties: { reply: { type: 'string' } },
} as const;

export function composePrompt(o: { comment: string; facts: unknown; lang: 'ar' | 'en' }) {
  const system = [
    "You write the brand's public reply to a customer's comment on Instagram for a Jordanian food company.",
    'Use ONLY the facts in the JSON. Never add a shop, date, price, quantity or promise that is not in the facts.',
    `Reply in ${o.lang === 'ar' ? 'Arabic, in a friendly Jordanian dialect (for example: "متوفر عند"، "بتلاقيه"، "احكيلنا")' : 'English'}.`,
    'Greet the customer by first name when it is given.',
    'Name at most 3 shops, written exactly as in the facts (Arabic names in Arabic replies, English names in English replies).',
    "Say the information is from our sales rep's last visit, and give the visit date of every shop you name (last_visit_ar or last_visit_en).",
    'If widened_from_requested_place is true, first say it was not found on the shelf in the requested place, then give the shops where it is.',
    'If requested_place_has_shops_that_carry_it is false, say we have no shop there that carries it, then give the nearest shops from the facts.',
    'If total_shops_with_it_on_shelf is 0, say kindly that it is not on the shelf at the shops our reps visited and that we will tell our sales team.',
    'If requested_place is null and shops is empty, mention the top cities and ask which area they are in.',
    'If pack_asked_does_not_exist is true, say we do not make that size and list packs_we_make.',
    'If question starts with "price only", lead with the shelf price range (and the visit dates it comes from) and do not list shops.',
    'Mention prices only when asked_about_price is true, using shelf_price_range_jod in JOD (دينار in Arabic), and say prices vary by shop.',
    'If a pack status is "low stock", say the quantity was low.',
    'Plain text, at most 70 words, line breaks allowed, at most 2 emojis. End by suggesting they check with the shop before going.',
  ].join('\n');
  const user = `Customer comment: ${o.comment}\nFacts (JSON):\n${JSON.stringify(o.facts)}`;
  return { system, user };
}

export const POST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['products', 'summary'],
  properties: {
    products: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['name', 'pack'], properties: { name: { type: 'string' }, pack: { type: ['string', 'null'] } } },
    },
    summary: { type: 'string' },
  },
} as const;

export function postPrompt(o: { caption: string; productHints: string[]; withImage?: boolean }) {
  const withImage = o.withImage !== false;
  const system = [
    withImage
      ? "You look at a food brand's Instagram post (the image and the caption) and list the food products it shows or talks about."
      : "You read the caption of a food brand's Instagram post and list the food products it talks about.",
    'Use the names from the known product list when a product matches one of them; otherwise write the name as it appears.',
    withImage ? 'Put a pack size in "pack" when it is visible or written, else null. Ignore props and decorations.' : 'Put a pack size in "pack" when it is written, else null.',
    'summary: one short English sentence describing the post.',
    `Known products: ${o.productHints.join('; ')}`,
  ].join('\n');
  return { system, user: `Caption: ${o.caption || '(no caption)'}` };
}
