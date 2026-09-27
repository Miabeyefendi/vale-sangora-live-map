'use strict';
// Two languages, English first. Static markup is tagged with data-i18n / data-i18n-title /
// data-i18n-tip / data-i18n-ph; script strings go through t(). The switch is the button in the map bar.
const I18N = {
  en: {
    search: 'Search markers...',
    markers: 'Markers', hide: 'Hide', show: 'Show',
    view: 'Show', all: 'All', finished: 'Finished', ongoing: 'Ongoing',
    auto: 'Automatic marking', desc: 'Description',
    autoWarn: 'Read from the game save: places the game reports as completed, quests finished in the journal, containers you emptied. Each is matched to the site marker by position, so a nearby marker can be marked by mistake (dense areas, chests inside camps), a quest without a start location stays unmarked, and sold or used items are invisible. Anything wrong: right-click to undo, it is never re-added. Off by default for quest chests and inventory.',
    autoInfoWait: 'Waiting for game data (open the in-game map once)',
    autoInfo: (pins, quests, chests, done, looted, marked) => `Can mark a nearby marker by mistake; right-click undoes it for good. Read so far: ${pins} game pins, ${quests} quests, ${chests} containers; ${done} completed, ${looted} containers emptied. Marked automatically: ${marked}`,
    optChest: 'Containers', optQuest: 'Quests', optPoi: 'Places', optLoot: 'Quest chests', optItem: 'Inventory',
    tipChest: 'Containers you emptied in the game (read while nearby) and the items inside',
    tipQuest: 'Quests finished in the journal and their objectives',
    tipPoi: 'Camps, lairs, shrines, towers: places the game reports as completed',
    tipLoot: 'The chest under a finished quest\'s objective pin; keep off if you tend to forget rewards',
    tipItem: 'Items on you or in shrine storage whose name matches a marker (sold / used ones are invisible)',
    calib: 'Calibration', recal: 'Recalibrate', refreshMap: 'Refresh',
    recalTip: 'Drop the calibration and compute it again from the game pins',
    refreshTip: 'Scan the game now (pins, journal, containers, inventory) and reload the page',
    recalConfirm: 'Drop the calibration and recompute it from the game pins?',
    calManual: (n, m) => `Manual, ${n} points, accuracy about ${m} m`,
    calAuto: (cat, k, n, m) => `Auto, ${k}/${n} ${cat}, accuracy about ${m} m`,
    calWait: () => 'Waiting for game pins (open the in-game map once)',
    readFirst: 'Read before use, hover the icon',
    location: 'Location', live: 'live', paused: 'paused (menu / focus lost)', waitingSave: 'game open, waiting for a save', gameClosed: 'game closed', noMod: 'no mod',
    follow: 'Follow',
    lockOn: 'Locked: the map keeps the player at the exact centre, zoom only. Click to free the map.',
    lockOff: 'Free: drag the map. Click to lock onto the player again.',
    reload: 'Scan the game now (pins, quests, containers, inventory) and reload the page',
    scanning: 'Scanning...',
    lang: 'Language: English. Click for Turkish.',
    close: 'Close', done: 'Done', doneOn: 'Done ✓', pin: 'Follow', pinOn: 'Following ✓', goto: 'Go to',
    doneTip: 'Right-click on the map does the same', pinTip: 'Yellow ring on the map, listed on the left', gotoTip: 'Centre the map here',
    note: 'Your own note...', loading: 'Loading...', contents: 'Contents', noResults: 'No results',
    item: 'Item', category: 'Category', position: 'Position', marker: 'Marker', guide: 'Guide', ggPage: 'GamerGuides page', source: 'Source',
    unpin: 'Stop following', tracked: 'Following',
    calHint: 'Calibration needed: stand at a Shrine, click it on the map, press "I am here". Finish with 3 different Shrines.',
    here: 'I am here', hereTip: 'Manual calibration: stand at a marker, open it in the panel, press',
  },
  tr: {
    search: 'Marker ara...',
    markers: 'Markerlar', hide: 'Gizle', show: 'Goster',
    view: 'Goster', all: 'Hepsi', finished: 'Bitenler', ongoing: 'Devam edenler',
    auto: 'Otomatik isaretleme', desc: 'Aciklama',
    autoWarn: 'Oyun kaydindan okunur: oyunun tamamlandi dedigi mekanlar, gunlukte biten gorevler, bosalttigin sandiklar. Her biri sitenin marker\'ina konumla eslenir; yakin bir marker yanlislikla isaretlenebilir (sik alanlar, kamp icindeki sandiklar), baslangic konumu olmayan gorev isaretlenmez, satilan/kullanilan esya gorunmez. Yanlis olani sag tikla geri al, bir daha eklenmez. Gorev sandiklari ve envanter varsayilan kapali.',
    autoInfoWait: 'Oyun verisi bekleniyor (oyunda M haritasini bir kez ac)',
    autoInfo: (pins, quests, chests, done, looted, marked) => `Yakindaki bir marker'i yanlislikla isaretleyebilir; sag tik kalici olarak geri alir. Okunan: ${pins} oyun pini, ${quests} gorev, ${chests} sandik; ${done} tamamlanmis, ${looted} sandik bosaltilmis. Otomatik isaretlenen: ${marked}`,
    optChest: 'Sandiklar', optQuest: 'Gorevler', optPoi: 'Mekanlar', optLoot: 'Gorev sandiklari', optItem: 'Envanter',
    tipChest: 'Oyunda bosalttigin sandiklar (yakinindayken okunur) ve icindeki esyalar',
    tipQuest: 'Gunlukte biten gorevler ve hedefleri',
    tipPoi: 'Kamp, yuva, tapinak, kule: oyunun tamamlandi dedigi yerler',
    tipLoot: 'Biten gorevin hedef pininin altindaki sandik; odulu almayi unutuyorsan kapali tut',
    tipItem: 'Ustunde veya tapinak deposunda duran, adi eslesen esyalar (satilan / kullanilan gorunmez)',
    calib: 'Kalibrasyon', recal: 'Yeniden kalibre', refreshMap: 'Yenile',
    recalTip: 'Kalibrasyonu sil ve oyun pinlerinden yeniden hesapla',
    refreshTip: 'Oyundan hemen tara (pin, gorev, sandik, envanter) ve sayfayi yenile',
    recalConfirm: 'Kalibrasyon silinip oyun pinlerinden yeniden hesaplansin mi?',
    calManual: (n, m) => `Elle, ${n} nokta, yaklasik ${m} m hassas`,
    calAuto: (cat, k, n, m) => `Otomatik, ${k}/${n} ${cat}, yaklasik ${m} m hassas`,
    calWait: () => 'Oyun pinleri bekleniyor (oyunda haritayi bir kez ac)',
    readFirst: 'Kullanmadan once oku, ikonun ustune gel',
    location: 'Konum', live: 'canli', paused: 'duraklatildi (menu / odak disari)', waitingSave: 'oyun acik, kayit bekleniyor', gameClosed: 'oyun kapali', noMod: 'mod yok',
    follow: 'Takip',
    lockOn: 'Kilitli: harita oyuncuyu tam ortada tutar, sadece yakinlastirma. Tikla, serbest kalsin.',
    lockOff: 'Serbest: haritayi kaydir. Tikla, oyuncuya kilitlensin.',
    reload: 'Oyundan hemen tara (pin, gorev, sandik, envanter) ve sayfayi yenile',
    scanning: 'Taraniyor...',
    lang: 'Dil: Turkce. Ingilizce icin tikla.',
    close: 'Kapat', done: 'Tamamlandi', doneOn: 'Tamamlandi ✓', pin: 'Takip et', pinOn: 'Takipte ✓', goto: 'Git',
    doneTip: 'Haritada sag tik da ayni isi yapar', pinTip: 'Haritada sari halka, solda liste', gotoTip: 'Haritada ortala',
    note: 'Kendi notun...', loading: 'Yukleniyor...', contents: 'Icindekiler', noResults: 'Sonuc yok',
    item: 'Oge', category: 'Kategori', position: 'Konum', marker: 'Marker', guide: 'Rehber', ggPage: 'GamerGuides sayfasi', source: 'Kaynak',
    unpin: 'Takipten cikar', tracked: 'Takipte',
    calHint: 'Kalibrasyon gerekli: bir Shrine\'in dibinde dur, haritada ona tikla, "Buradayim"a bas. 3 farkli Shrine ile bitir.',
    here: 'Buradayim', hereTip: 'Elle kalibrasyon: bir marker\'in dibinde dur, panelde ac, bas',
  },
};
let LANG = localStorage.getItem('lang') || 'en';
function t(key, ...args) {
  const v = (I18N[LANG] && I18N[LANG][key]) || I18N.en[key] || key;
  return typeof v === 'function' ? v(...args) : v;
}
function applyI18n() {
  document.documentElement.lang = LANG;
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.dataset.i18nTitle); });
  document.querySelectorAll('[data-i18n-tip]').forEach(el => { el.dataset.tip = t(el.dataset.i18nTip); });
  document.querySelectorAll('[data-i18n-ph]').forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
  const b = document.getElementById('btn-lang');
  if (b) { b.textContent = LANG.toUpperCase(); b.title = t('lang'); }
}
function setLang(l) {
  LANG = l;
  localStorage.setItem('lang', l);
  applyI18n();
}
document.addEventListener('DOMContentLoaded', () => {
  applyI18n();
  const b = document.getElementById('btn-lang');
  if (b) b.addEventListener('click', () => { setLang(LANG === 'en' ? 'tr' : 'en'); if (typeof onLangChange === 'function') onLangChange(); });
});
