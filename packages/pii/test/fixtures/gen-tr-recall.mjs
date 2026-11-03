#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Writes tr-recall.json: Turkish sentences with the personal data in them marked (tracker
// P1-13). All made up, and the same each run. Identifiers pass their checksums, because
// real ones do, and the detectors check them. Run: node packages/pii/test/fixtures/gen-tr-recall.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// A small seeded generator, so the file doesn't change between runs.
let state = 20261103;
const rand = (n) => {
  state = (state * 1664525 + 1013904223) % 4294967296;
  return Math.floor((state / 4294967296) * n);
};
const pick = (list) => list[rand(list.length)];
const digits = (n) => Array.from({ length: n }, () => rand(10)).join('');

function tckn() {
  const d = [1 + rand(9), ...Array.from({ length: 8 }, () => rand(10))];
  const odd = d[0] + d[2] + d[4] + d[6] + d[8];
  const even = d[1] + d[3] + d[5] + d[7];
  const tenth = (((odd * 7 - even) % 10) + 10) % 10;
  const eleventh = (d.reduce((a, b) => a + b, 0) + tenth) % 10;
  return [...d, tenth, eleventh].join('');
}

function vkn() {
  const d = Array.from({ length: 9 }, () => rand(10));
  let sum = 0;
  d.forEach((value, i) => {
    const power = 9 - i;
    const tmp = (value + power) % 10;
    if (tmp !== 0) {
      const part = (tmp * 2 ** power) % 9;
      sum += part === 0 ? 9 : part;
    }
  });
  return `${d.join('')}${(10 - (sum % 10)) % 10}`;
}

function iban() {
  const bban = `${digits(5)}0${digits(16)}`;
  const numeric = `${bban}292700`; // TR = 29 27, then 00.
  let remainder = 0;
  for (const c of numeric) remainder = (remainder * 10 + Number(c)) % 97;
  const check = String(98 - remainder).padStart(2, '0');
  return `TR${check}${bban}`;
}
const spacedIban = (v) => v.match(/.{1,4}/g).join(' ');

function card() {
  const body = `4${digits(14)}`;
  let sum = 0;
  [...body].reverse().forEach((c, i) => {
    let n = Number(c);
    if (i % 2 === 0) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  });
  return `${body}${(10 - (sum % 10)) % 10}`;
}
const spacedCard = (v, sep) => v.match(/.{1,4}/g).join(sep);

const phone = () => {
  const a = `5${pick(['30', '32', '35', '42', '44', '05', '52', '55', '59'])}`;
  const b = digits(3);
  const c = digits(2);
  const d = digits(2);
  return pick([
    `+90 ${a} ${b} ${c} ${d}`,
    `0${a} ${b} ${c} ${d}`,
    `0${a}${b}${c}${d}`,
    `(0${a}) ${b} ${c} ${d}`,
    `+90${a}${b}${c}${d}`,
    `0 ${a} ${b} ${c}${d}`,
    `0${a}-${b}-${c}-${d}`,
    `0${pick(['212', '216', '312', '232', '322'])} ${b} ${c} ${d}`,
    `+90 (${a}) ${b} ${c} ${d}`,
  ]);
};

const FIRST = [
  'Ayşe',
  'Mehmet',
  'Fatma',
  'Mustafa',
  'Zeynep',
  'Ahmet',
  'Elif',
  'Ali',
  'Emine',
  'Hüseyin',
  'Hatice',
  'İbrahim',
  'Merve',
  'Hasan',
  'Özge',
  'Çağlar',
  'Gökhan',
  'Şule',
  'Burak',
  'İrem',
  'Ümit',
  'Sevgi',
  'Tolga',
  'Derya',
];
const LAST = [
  'Yılmaz',
  'Kaya',
  'Demir',
  'Çelik',
  'Şahin',
  'Yıldız',
  'Öztürk',
  'Aydın',
  'Özdemir',
  'Arslan',
  'Doğan',
  'Kılıç',
  'Aslan',
  'Çetin',
  'Kara',
  'Koç',
  'Kurt',
  'Özkan',
  'Şimşek',
  'Polat',
];
const fullName = () => `${pick(FIRST)} ${pick(LAST)}`;
const trLower = (s) => s.replaceAll('I', 'ı').replaceAll('İ', 'i').toLowerCase();
const trUpper = (s) => s.replaceAll('i', 'İ').replaceAll('ı', 'I').toUpperCase();

const email = () => {
  const local = pick([
    'ayse.yilmaz',
    'm.kaya',
    'muhasebe',
    'info',
    'zeynep_demir',
    'ahmet.celik85',
    'ik-birim',
  ]);
  return `${local}@${pick(['ornek.com.tr', 'firma.com', 'sirket.net.tr', 'gmail.com', 'kurum.gov.tr'])}`;
};

const cases = [];
const add = (text, type, value, style) => cases.push({ text, entities: [{ type, value }], style });

const TCKN_TEMPLATES = [
  (v) => `Müşterinin T.C. kimlik numarası ${v} olarak kayıtlı.`,
  (v) => `TCKN: ${v}`,
  (v) => `Kimlik no ${v} ile başvuru yapıldı.`,
  (v) => `Lütfen ${v} numaralı kişinin dosyasını açın.`,
  (v) => `tc ${v} sisteme girilemedi, kontrol eder misiniz?`,
  (v) => `Sözleşmedeki kimlik numarasını ${v} olarak düzelttik.`,
  (v) => `${v}, personelin T.C. numarasıdır.`,
  (v) => `Başvuran: T.C. Kimlik No: ${v}, tarih 12.03.2026.`,
];
const VKN_TEMPLATES = [
  (v) => `Firmanın vergi numarası ${v} olarak geçiyor.`,
  (v) => `VKN: ${v}`,
  (v) => `Faturadaki vergi kimlik numarası ${v} doğru mu?`,
  (v) => `Vergi no ${v} için e-fatura kaydı açıldı.`,
  (v) => `Tedarikçi, vergi numarası: ${v}, Kadıköy Vergi Dairesi.`,
];
const IBAN_TEMPLATES = [
  (v) => `Ödemeyi ${v} numaralı hesaba yapın.`,
  (v) => `IBAN: ${v}`,
  (v) => `Maaş hesabım ${v}, buna yatırılsın.`,
  (v) => `Alıcı IBAN'ı ${v} olarak değiştirildi.`,
  (v) => `Havale için hesap: ${v} (Ziraat)`,
];
const PHONE_TEMPLATES = [
  (v) => `Beni ${v} numarasından arayabilirsiniz.`,
  (v) => `Telefon: ${v}`,
  (v) => `Müşteri cep telefonunu ${v} olarak güncelledi.`,
  (v) => `Acil durumda ${v} aranacak.`,
  (v) => `İletişim bilgisi ${v}, mesai saatlerinde ulaşılır.`,
];
const EMAIL_TEMPLATES = [
  (v) => `Raporu ${v} adresine gönderin.`,
  (v) => `E-posta: ${v}`,
  (v) => `Bana ${v} üzerinden yazabilirsiniz.`,
  (v) => `Fatura ${v} adresine iletilsin lütfen.`,
];
const CARD_TEMPLATES = [
  (v) => `Kart numaram ${v}, son kullanma 12/28.`,
  (v) => `Ödeme ${v} numaralı karttan alındı.`,
  (v) => `Kredi kartı: ${v}`,
  (v) => `Müşterinin kartı ${v} iade için kullanılacak.`,
];

const repeat = (templates, count, make, type, style) => {
  for (let i = 0; i < count; i += 1) {
    const value = make();
    add(templates[i % templates.length](value), type, value, style);
  }
};
repeat(TCKN_TEMPLATES, 32, tckn, 'TR_TCKN', 'plain');
repeat(VKN_TEMPLATES, 25, vkn, 'TR_VKN', 'plain');
repeat(IBAN_TEMPLATES, 15, iban, 'TR_IBAN', 'compact');
repeat(IBAN_TEMPLATES, 15, () => spacedIban(iban()), 'TR_IBAN', 'spaced');
repeat(PHONE_TEMPLATES, 35, phone, 'TR_PHONE', 'mixed');
repeat(EMAIL_TEMPLATES, 24, email, 'EMAIL_ADDRESS', 'plain');
repeat(CARD_TEMPLATES, 8, card, 'CREDIT_CARD', 'compact');
repeat(CARD_TEMPLATES, 8, () => spacedCard(card(), ' '), 'CREDIT_CARD', 'spaced');
repeat(CARD_TEMPLATES, 8, () => spacedCard(card(), '-'), 'CREDIT_CARD', 'dashed');

// Names, as they really appear: inflected, with titles, and in any case.
const NAME_TEMPLATES = [
  (v) => [`${v} bugün toplantıya katılmayacak.`, v],
  (v) => [`Sözleşmeyi ${v} imzaladı.`, v],
  (v) => [`${v} ile görüştüm, teklifi kabul etti.`, v],
  (v) => [`Dosyayı ${v}'a ilet lütfen.`, v],
  (v) => [`${v}'ın izin talebi onaylandı.`, v],
  (v) => [`${v}'den gelen e-postayı okudun mu?`, v],
  (v) => [`Sayın ${v}, başvurunuz alınmıştır.`, v],
  (v) => [`Müşterimiz ${v} şikayetini iletti.`, v],
  (v) => [`Yönetici olarak ${v} atandı.`, v],
  (v) => [`Merhaba, ben ${v}, muhasebeden arıyorum.`, v],
  (v) => [`${v} Bey'e toplantı notlarını gönderdik.`, v],
  (v) => [`${v} Hanım yarın ofiste olacak.`, v],
  (v) => [`Bu raporu ${v} hazırladı, ona sorabilirsiniz.`, v],
  (v) => [`Ekipten ${v} ayrılıyor, yerine yeni biri alınacak.`, v],
  (v) => [`Hasta ${v}, kontrol için çağrıldı.`, v],
  (v) => [`Velisi ${v} okula geldi.`, v],
  (v) => [`Avukat ${v} dilekçeyi hazırladı.`, v],
  (v) => [`Dr. ${v} randevuyu erteledi.`, v],
];
for (let i = 0; i < NAME_TEMPLATES.length * 3; i += 1) {
  const [text, value] = NAME_TEMPLATES[i % NAME_TEMPLATES.length](fullName());
  add(text, 'PERSON', value, 'title case');
}
for (let i = 0; i < NAME_TEMPLATES.length; i += 1) {
  const [text, value] = NAME_TEMPLATES[i % NAME_TEMPLATES.length](trLower(fullName()));
  add(text, 'PERSON', value, 'lower case');
}
for (let i = 0; i < NAME_TEMPLATES.length; i += 1) {
  const [text, value] = NAME_TEMPLATES[i % NAME_TEMPLATES.length](trUpper(fullName()));
  add(text, 'PERSON', value, 'upper case');
}

// The names above are the commonest ones. These are harder, so the number isn't flattered.
const RARE_FIRST = [
  'Nilüfer',
  'Cemre',
  'Kaan',
  'Alperen',
  'Berfin',
  'Rojda',
  'Serhat',
  'Yağmur',
  'Ecrin',
  'Eymen',
  'Göksu',
  'Mihriban',
  'Dilan',
  'Hamza',
  'Sude',
  'Tuğba',
];
const RARE_LAST = [
  'Karadeniz',
  'Bozkurt',
  'Tekin',
  'Akyüz',
  'Erdem',
  'Sarıgül',
  'Uçar',
  'Bingöl',
  'Ateş',
  'Yavuz',
  'Taşdemir',
  'Kahraman',
];
const FOREIGN = [
  'John Smith',
  'Maria Garcia',
  'Hans Müller',
  'Olga Petrova',
  'Ahmed Hassan',
  'Giorgi Beridze',
  'Anna Kowalska',
  'Pierre Dubois',
];
for (let i = 0; i < NAME_TEMPLATES.length; i += 1) {
  const [text, value] = NAME_TEMPLATES[i](`${pick(RARE_FIRST)} ${pick(RARE_LAST)}`);
  add(text, 'PERSON', value, 'less common');
}
for (let i = 0; i < NAME_TEMPLATES.length; i += 1) {
  const [text, value] = NAME_TEMPLATES[i](`${pick(FIRST)} ${pick(RARE_FIRST)} ${pick(LAST)}`);
  add(text, 'PERSON', value, 'three words');
}
for (let i = 0; i < NAME_TEMPLATES.length; i += 1) {
  const [text, value] = NAME_TEMPLATES[i](pick(FOREIGN));
  add(text, 'PERSON', value, 'foreign');
}
for (let i = 0; i < NAME_TEMPLATES.length; i += 1) {
  const [text, value] = NAME_TEMPLATES[i](pick([...FIRST, ...RARE_FIRST]));
  add(text, 'PERSON', value, 'first name');
}

// Several in one sentence, as in a real pasted record.
for (let i = 0; i < 12; i += 1) {
  const n = fullName();
  const t = tckn();
  const e = email();
  const p = phone();
  cases.push({
    text: `Personel: ${n}, T.C. ${t}, e-posta ${e}, telefon ${p}.`,
    entities: [
      { type: 'PERSON', value: n },
      { type: 'TR_TCKN', value: t },
      { type: 'EMAIL_ADDRESS', value: e },
      { type: 'TR_PHONE', value: p },
    ],
    style: 'record',
  });
}

// Nothing personal, including numbers that look close. Nothing here should be found.
const CLEAN = [
  'Toplantı yarın saat 14.00’te başlayacak.',
  'Ciro geçen yıla göre yüzde 12 arttı.',
  'Sipariş numarası 12345678901 olan ürün depoda.',
  'Stok kodu 10000000147 sistemde görünmüyor.',
  'Fatura tutarı 1.250,00 TL olarak hesaplandı.',
  'Proje teslim tarihi 15.04.2026 olarak güncellendi.',
  'Ankara ofisi bu hafta kapalı olacak.',
  'İstanbul’daki depo genişletilecek.',
  'Yeni ürünümüz Mart ayında çıkıyor.',
  'Satış raporunu Excel olarak hazırlayın.',
  'Sunucu 192.168.1.10 adresinde çalışıyor.',
  'Kargo takip numarası 4242424242424241 sorgulanamadı.',
  'Bugün hava çok güzel, dışarı çıkalım.',
  'Bilgisayar programı güncelleme istiyor.',
  'Yönetim kurulu kararı tutanağa geçirildi.',
  'Müşteri memnuniyeti anketi sonuçlandı.',
  'Türkiye Cumhuriyet Merkez Bankası faizi açıkladı.',
  'Kadıköy şubesi hafta sonu açık.',
  'Vergi dairesine gidilmesi gerekiyor.',
  // Words that are also names, and organisations, which aren't people.
  'Güneş enerjisi yatırımı bu yıl arttı.',
  'Demir çelik fiyatları yükseliyor.',
  'Deniz kenarındaki tesis kapandı.',
  'Umut verici sonuçlar aldık.',
  'Kaya parçaları yolu kapattı.',
  'Yıldız Teknik Üniversitesi ile anlaşma imzalandı.',
  'Doğan Haber Ajansı açıklama yaptı.',
  'Ankara Büyükşehir Belediyesi ihaleye çıktı.',
  'Microsoft Teams toplantısı ertelendi.',
  'Kaya Holding bu yıl halka arz oluyor.',
  'Müşteri numarası 2123456789 sistemde görünmüyor.',
];

// Longer text, where the model is less sure of itself than in one short sentence.
const SENTENCES = [
  'Toplantıda satış rakamları ve yeni ürün planı konuşuldu.',
  'Herkes görüşlerini paylaştı, karar gelecek haftaya kaldı.',
  'Depodaki stok sayımı tamamlandı, eksik ürünler listelendi.',
  'Bütçe tablosu güncellendi ve yönetime iletildi.',
];
for (let i = 0; i < 24; i += 1) {
  const [a, b, c] = [fullName(), `${pick(RARE_FIRST)} ${pick(LAST)}`, fullName()];
  cases.push({
    text: `${pick(SENTENCES)} ${a} bunu onayladı. ${pick(SENTENCES)} Konuyu ${b} ile görüştük. ${pick(SENTENCES)} ${c} toplantıya gelmedi.`,
    entities: [a, b, c].map((value) => ({ type: 'PERSON', value })),
    style: 'paragraph',
  });
}
for (let i = 0; i < 12; i += 1) {
  const value = i % 2 === 0 ? fullName() : `${pick(RARE_FIRST)} ${pick(RARE_LAST)}`;
  add(
    `Saygılarımla,\n${value}\n${pick(['Muhasebe Müdürü', 'Satış Uzmanı', 'İK Sorumlusu'])}`,
    'PERSON',
    value,
    'signature',
  );
}
const ENGLISH = [
  (v) => `Please send the report to ${v} by Friday.`,
  (v) => `Our customer ${v} called about the invoice.`,
  (v) => `The meeting with ${v} is at noon.`,
  (v) => `${v} approved the contract yesterday.`,
];
for (let i = 0; i < 12; i += 1) {
  const value = i % 2 === 0 ? pick(FOREIGN) : fullName();
  add(ENGLISH[i % ENGLISH.length](value), 'PERSON', value, 'english');
}

const out = { generatedBy: 'gen-tr-recall.mjs', cases, clean: CLEAN };
const here = dirname(fileURLToPath(import.meta.url));
writeFileSync(join(here, 'tr-recall.json'), `${JSON.stringify(out, null, 1)}\n`);
console.log(`${cases.length} sentences with personal data, ${CLEAN.length} without`);
