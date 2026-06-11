// Language selector data, extracted from SearchPage for readability.

export const TOP_LANGUAGES = [
  { code: 'eng', label: 'English'            },
  { code: 'jpn', label: 'Japanese'           },
  { code: 'deu', label: 'German'             },
  { code: 'mul', label: 'Multiple languages' },
  { code: 'fra', label: 'French'             },
  { code: 'spa', label: 'Spanish'            },
];
export const TOP_LANG_CODES = new Set(TOP_LANGUAGES.map(l => l.code));

// Full ISO 639-3 list for the modal (top languages present in the DB)
export const ISO_LANGUAGE_NAMES = ([
  ['afr','Afrikaans'],       ['amh','Amharic'],         ['ara','Arabic'],
  ['ast','Asturian'],        ['aze','Azerbaijani'],      ['bam','Bambara'],
  ['bel','Belarusian'],      ['ben','Bengali'],          ['bos','Bosnian'],
  ['bre','Breton'],          ['bul','Bulgarian'],        ['cat','Catalan'],
  ['ceb','Cebuano'],         ['ces','Czech'],            ['cmn','Mandarin Chinese'],
  ['cos','Corsican'],        ['cym','Welsh'],            ['dan','Danish'],
  ['deu','German'],          ['ell','Greek'],            ['eng','English'],
  ['est','Estonian'],        ['eus','Basque'],           ['fas','Persian'],
  ['fil','Filipino'],        ['fin','Finnish'],          ['fra','French'],
  ['frc','Cajun French'],    ['gla','Scottish Gaelic'],  ['gle','Irish'],
  ['glg','Galician'],        ['gsw','Swiss German'],     ['guj','Gujarati'],
  ['hat','Haitian Creole'],  ['haw','Hawaiian'],         ['heb','Hebrew'],
  ['hin','Hindi'],           ['hrv','Croatian'],         ['hun','Hungarian'],
  ['ind','Indonesian'],      ['isl','Icelandic'],        ['ita','Italian'],
  ['jpn','Japanese'],        ['kan','Kannada'],          ['kat','Georgian'],
  ['kaz','Kazakh'],          ['kor','Korean'],           ['ksh','Kölsch'],
  ['kur','Kurdish'],         ['lat','Latin'],            ['lav','Latvian'],
  ['lit','Lithuanian'],      ['mal','Malayalam'],        ['mar','Marathi'],
  ['mkd','Macedonian'],      ['moe','Innu-aimun'],       ['mri','Māori'],
  ['msa','Malay'],           ['mul','Multiple languages'],['mya','Burmese'],
  ['nld','Dutch'],           ['nno','Norwegian Nynorsk'],['nob','Norwegian Bokmål'],
  ['non','Old Norse'],       ['nor','Norwegian'],        ['oci','Occitan'],
  ['pan','Punjabi'],         ['pol','Polish'],           ['por','Portuguese'],
  ['ron','Romanian'],        ['run','Rundi'],            ['rus','Russian'],
  ['san','Sanskrit'],        ['slk','Slovak'],           ['slv','Slovenian'],
  ['sme','Northern Sami'],   ['spa','Spanish'],          ['sqi','Albanian'],
  ['srp','Serbian'],         ['swa','Swahili'],          ['swe','Swedish'],
  ['tam','Tamil'],           ['tel','Telugu'],           ['tgl','Tagalog'],
  ['tha','Thai'],            ['tmh','Tamashek'],         ['tok','Toki Pona'],
  ['tur','Turkish'],         ['ukr','Ukrainian'],        ['urd','Urdu'],
  ['uzb','Uzbek'],           ['vie','Vietnamese'],       ['wol','Wolof'],
  ['yid','Yiddish'],         ['yue','Cantonese'],        ['zho','Chinese'],
  ['zul','Zulu'],            ['zxx','No linguistic content'],
] as [string, string][]).sort((a, b) => a[1].localeCompare(b[1]));
