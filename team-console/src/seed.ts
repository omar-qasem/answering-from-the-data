// The demo content: a fictional brand, eight customers, five older posts and their comments.
// A few comments come already answered (the answers are generated from the data when the demo is seeded).
import type { CommentRec, Persona, PostCtx, PostRec } from './types';

export const BRAND = { name: 'Bayt Al Mouneh', name_ar: 'بيت المونة', handle: 'baytalmouneh', avatar: '/seed/brand.png' };

export const PERSONAS: Persona[] = [
  { id: 'sara', name: 'سارة حداد', handle: 'sara.haddad', color: '#e4572e' },
  { id: 'ahmad', name: 'أحمد الخطيب', handle: 'ahmad.khatib', color: '#1f7a8c' },
  { id: 'lina', name: 'لينا عودة', handle: 'lina.odeh', color: '#8e44ad' },
  { id: 'rania', name: 'رانيا صالح', handle: 'rania.saleh', color: '#d35400' },
  { id: 'yousef', name: 'يوسف حمدان', handle: 'yousef.hamdan', color: '#2e7d32' },
  { id: 'mais', name: 'ميس العزام', handle: 'mais.azzam', color: '#c2185b' },
  { id: 'tariq', name: 'طارق جابر', handle: 'tariq.jaber', color: '#455a64' },
  { id: 'emily', name: 'Emily Carter', handle: 'emily.carter', color: '#0077b6' },
];

interface SeedComment {
  id: string;
  persona: string;
  text: string;
  after_min: number; // minutes after the post
  answered?: boolean; // seeded with a reply already sent
}

interface SeedPost {
  id: string;
  days_ago: number;
  image: string;
  caption: string;
  products: { id: string; name: string; name_ar: string; pack: string | null }[];
  summary: string;
  comments: SeedComment[];
}

export const SEED_POSTS: SeedPost[] = [
  {
    id: 'post-olive-oil',
    days_ago: 1,
    image: '/seed/olive-oil.jpg',
    caption: 'موسم الزيت الجديد وصل 🫒✨\nزيت زيتون بكر ممتاز، عصرة أولى على البارد. عبوة 750 مل.\nمين جرّبه؟ احكولنا بالتعليقات 👇\n#بيت_المونة #زيت_زيتون',
    products: [{ id: 'product:olive oil extra virgin', name: 'Olive Oil Extra Virgin', name_ar: 'زيت زيتون بكر ممتاز', pack: '750 ml' }],
    summary: 'New-season extra virgin olive oil, 750 ml bottle.',
    comments: [
      { id: 'c-oil-1', persona: 'lina', text: 'بكم سعره؟', after_min: 25, answered: true },
      { id: 'c-oil-2', persona: 'sara', text: 'وين بلاقيه بخلدا؟', after_min: 50 },
      { id: 'c-oil-3', persona: 'emily', text: 'Is this available in Aqaba?', after_min: 130 },
      { id: 'c-oil-4', persona: 'rania', text: 'يسلمو ايديكم أطيب زيت جربته 😍', after_min: 190 },
      { id: 'c-oil-5', persona: 'ahmad', text: 'زيت زيتوون بالزرقا متوفر؟', after_min: 300 },
    ],
  },
  {
    id: 'post-milk-powder',
    days_ago: 2,
    image: '/seed/milk-powder.jpg',
    caption: 'حليب بودرة كامل الدسم 🥛 بثلاث أحجام تناسب كل بيت: 400 غ، 900 غ، و1.8 كغ للعيلة الكبيرة.\nفطوركم ما بكمل بدونه ☀️\n#بيت_المونة',
    products: [{ id: 'product:full cream milk powder', name: 'Full Cream Milk Powder', name_ar: 'حليب بودرة كامل الدسم', pack: null }],
    summary: 'Full cream milk powder in three sizes: 400 g, 900 g and 1.8 kg.',
    comments: [
      { id: 'c-milk-1', persona: 'rania', text: 'في منه الكبير ٢ كيلو بإربد؟', after_min: 60 },
      { id: 'c-milk-2', persona: 'yousef', text: 'حليب بودره متوفر؟', after_min: 170 },
      { id: 'c-milk-3', persona: 'mais', text: 'الحجم الوسط بكم؟', after_min: 240 },
      { id: 'c-milk-4', persona: 'tariq', text: '@sara.haddad هاد اللي حكيتلك عنه 👌', after_min: 360 },
    ],
  },
  {
    id: 'post-coffee',
    days_ago: 3,
    image: '/seed/turkish-coffee.jpg',
    caption: 'صباحكم قهوة ☕\nقهوة تركية مطحونة طازة، تحميصة وسط مع هيل خفيف. عبوة 250 غ.\nقهوتك الصبح سادة ولا مع سكر؟ 👇\n#بيت_المونة #قهوة',
    products: [{ id: 'product:turkish coffee ground', name: 'Turkish Coffee Ground', name_ar: 'قهوة تركية مطحونة', pack: '250 g' }],
    summary: 'Freshly ground Turkish coffee with a hint of cardamom, 250 g.',
    comments: [
      { id: 'c-cof-1', persona: 'yousef', text: 'وين بلاقيها بالشميساني؟', after_min: 35, answered: true },
      { id: 'c-cof-2', persona: 'sara', text: 'قهوتكم بتجنن ☕ في عندكم كمان شاي أخضر؟ وين بلاقيه بالجبيهة؟', after_min: 120 },
      { id: 'c-cof-3', persona: 'emily', text: 'Where can I buy it near Abdoun?', after_min: 300 },
      { id: 'c-cof-4', persona: 'tariq', text: 'عندكم قهوه بكارفور الجاليريا؟', after_min: 720 },
      { id: 'c-cof-5', persona: 'lina', text: 'بتوصلو لإربد؟', after_min: 900 },
    ],
  },
  {
    id: 'post-tahini-halawa',
    days_ago: 4,
    image: '/seed/tahini-halawa.jpg',
    caption: 'صحن الفطور ما بكمل بدون طحينة وحلاوة 😋\nطحينة 400 غ من سمسم محمّص، وحلاوة سادة 450 غ.\n#بيت_المونة #فطور',
    products: [
      { id: 'product:tahini', name: 'Tahini', name_ar: 'طحينة', pack: '400 g' },
      { id: 'product:halawa plain', name: 'Halawa Plain', name_ar: 'حلاوة سادة', pack: '450 g' },
    ],
    summary: 'Breakfast spread: tahini 400 g and plain halawa 450 g.',
    comments: [
      { id: 'c-tah-1', persona: 'rania', text: 'وين بلاقي الطحينة بالزرقاء؟', after_min: 30, answered: true },
      { id: 'c-tah-2', persona: 'ahmad', text: 'وين بلاقي الطحينة والحلاوة بمادبا؟', after_min: 80 },
      { id: 'c-tah-3', persona: 'mais', text: 'الحلاوة متوفرة بإربد؟', after_min: 200 },
      { id: 'c-tah-4', persona: 'tariq', text: 'اشتريت علبة حلاوة الأسبوع الماضي وكانت منتهية 😡', after_min: 1500 },
    ],
  },
  {
    id: 'post-freekeh',
    days_ago: 6,
    image: '/seed/freekeh.jpg',
    caption: 'فريكة بلدية محمّصة على الحطب 🔥🌾\nجاهزة لشوربة الشتاء وطبخة الدجاج. عبوة 1 كغ.\n#بيت_المونة #فريكة',
    products: [{ id: 'product:freekeh', name: 'Freekeh', name_ar: 'فريكة', pack: '1 kg' }],
    summary: 'Fire-roasted local freekeh, 1 kg bag.',
    comments: [
      { id: 'c-frk-1', persona: 'emily', text: 'Is it available in Irbid?', after_min: 45, answered: true },
      { id: 'c-frk-2', persona: 'yousef', text: 'فريكه بالسلط في؟', after_min: 110 },
      { id: 'c-frk-3', persona: 'mais', text: 'وين القاها بعمان', after_min: 260 },
      { id: 'c-frk-4', persona: 'lina', text: 'وعندكم رز؟ وين بلاقيه بماركا؟', after_min: 1440 },
    ],
  },
];

export function seedRecords(now = Date.now()) {
  const posts: PostRec[] = [];
  const ctxs: PostCtx[] = [];
  const comments: CommentRec[] = [];
  const answered: CommentRec[] = [];
  for (const p of SEED_POSTS) {
    const t = now - p.days_ago * 86400000;
    posts.push({ id: p.id, created_at: new Date(t).toISOString(), caption: p.caption, image: p.image, seed: true });
    ctxs.push({
      post_id: p.id,
      status: 'done',
      products: p.products.map((x) => ({ ...x, source: 'seed', conf: 1 })),
      summary: p.summary,
      by: 'seed',
      analyzed_at: new Date(t).toISOString(),
    });
    for (const c of p.comments) {
      const per = PERSONAS.find((x) => x.id === c.persona)!;
      const rec: CommentRec = { id: c.id, post_id: p.id, created_at: new Date(Math.min(now - 60000, t + c.after_min * 60000)).toISOString(), persona_id: per.id, author_name: per.name, author_handle: per.handle, text: c.text, seed: true };
      comments.push(rec);
      if (c.answered) answered.push(rec);
    }
  }
  return { posts, ctxs, comments, answered };
}
