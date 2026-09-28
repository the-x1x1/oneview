/**
 * The flag an AIS station's MMSI implies, from its Maritime Identification Digits (MID).
 *
 * An MMSI (ITU-R M.585) is nine digits. For a ship station the first three are the MID —
 * the administration that assigned the number, which is the flag state the ship is
 * registered under (a Panama-flagged ship is 351–357, 370–374). Other kinds of station put
 * the MID elsewhere: a coast station is 00MIDxxxx, a group of ships 0MIDxxxxx, a search-and-
 * rescue aircraft 111MIDxxx, a handheld VHF with DSC 8MIDxxxxx, a craft associated with a
 * parent ship 98MIDxxxx and an aid to navigation 99MIDxxxx. AIS-SARTs, man-overboard devices
 * and EPIRB-AIS (970, 972, 974) carry no MID at all.
 *
 * The flag is what the number says, not a verified registration: an MMSI is typed into the
 * transponder by whoever installs it, and a wrong or borrowed one says the wrong flag. The
 * context panel says so.
 *
 * MID_ALLOCATIONS: the ITU's public table of Maritime Identification Digits (ITU-R, MARS,
 * https://www.itu.int/gladapp/Allocation/MIDs, read 2026-09-27). Re-keyed as facts — which
 * number is allocated to which administration — with WORLDVIEW's own short English names in
 * place of the ITU's formal ones; no text of the ITU's document is reproduced. Recorded in
 * config/licenses/assets.json.
 */
export type MmsiStationKind =
  | 'ship'
  | 'coast-station'
  | 'group'
  | 'sar-aircraft'
  | 'handheld'
  | 'associated-craft'
  | 'aid-to-navigation'
  | 'emergency-device';

export const MMSI_STATION_KIND_TEXT: Readonly<Record<MmsiStationKind, string>> = Object.freeze({
  ship: 'Ship',
  'coast-station': 'Coast station',
  group: 'Group of ships',
  'sar-aircraft': 'Search and rescue aircraft',
  handheld: 'Handheld radio',
  'associated-craft': 'Craft associated with a parent ship',
  'aid-to-navigation': 'Aid to navigation',
  'emergency-device': 'AIS-SART, man-overboard or EPIRB device',
});

export interface MmsiFlag {
  kind: MmsiStationKind;
  /** The three MID digits, when the kind carries them. */
  mid?: string;
  /** The administration the MID is allocated to, when the MID is allocated. */
  country?: string;
}

/** MID → administration. Ranges are written out so every number has a row. */
export const MID_ALLOCATIONS: Readonly<Record<string, string>> = Object.freeze(buildTable());

function buildTable(): Record<string, string> {
  const rows: Array<[string, string]> = [
    ['201', 'Albania'],
    ['202', 'Andorra'],
    ['203', 'Austria'],
    ['204', 'Portugal (Azores)'],
    ['205', 'Belgium'],
    ['206', 'Belarus'],
    ['207', 'Bulgaria'],
    ['208', 'Vatican City State'],
    ['209 210 212', 'Cyprus'],
    ['211 218', 'Germany'],
    ['213', 'Georgia'],
    ['214', 'Moldova'],
    ['215 229 248 249 256', 'Malta'],
    ['216', 'Armenia'],
    ['219 220', 'Denmark'],
    ['224 225', 'Spain'],
    ['226 227 228', 'France'],
    ['230', 'Finland'],
    ['231', 'Denmark (Faroe Islands)'],
    ['232 233 234 235', 'United Kingdom'],
    ['236', 'United Kingdom (Gibraltar)'],
    ['237 239 240 241', 'Greece'],
    ['238', 'Croatia'],
    ['242', 'Morocco'],
    ['243', 'Hungary'],
    ['244 245 246', 'Netherlands'],
    ['247', 'Italy'],
    ['250', 'Ireland'],
    ['251', 'Iceland'],
    ['252', 'Liechtenstein'],
    ['253', 'Luxembourg'],
    ['254', 'Monaco'],
    ['255', 'Portugal (Madeira)'],
    ['257 258 259', 'Norway'],
    ['261', 'Poland'],
    ['262', 'Montenegro'],
    ['263', 'Portugal'],
    ['264', 'Romania'],
    ['265 266', 'Sweden'],
    ['267', 'Slovakia'],
    ['268', 'San Marino'],
    ['269', 'Switzerland'],
    ['270', 'Czech Republic'],
    ['271', 'Türkiye'],
    ['272', 'Ukraine'],
    ['273', 'Russian Federation'],
    ['274', 'North Macedonia'],
    ['275', 'Latvia'],
    ['276', 'Estonia'],
    ['277', 'Lithuania'],
    ['278', 'Slovenia'],
    ['279', 'Serbia'],
    ['301', 'United Kingdom (Anguilla)'],
    ['303', 'United States (Alaska)'],
    ['304 305', 'Antigua and Barbuda'],
    ['306', 'Netherlands (Caribbean: Bonaire, Curaçao, Saba, Sint Eustatius, Sint Maarten)'],
    ['307', 'Netherlands (Aruba)'],
    ['308 309 311', 'Bahamas'],
    ['310', 'United Kingdom (Bermuda)'],
    ['312', 'Belize'],
    ['314', 'Barbados'],
    ['316', 'Canada'],
    ['319', 'United Kingdom (Cayman Islands)'],
    ['321', 'Costa Rica'],
    ['323', 'Cuba'],
    ['325', 'Dominica'],
    ['327', 'Dominican Republic'],
    ['329', 'France (Guadeloupe)'],
    ['330', 'Grenada'],
    ['331', 'Denmark (Greenland)'],
    ['332', 'Guatemala'],
    ['334', 'Honduras'],
    ['336', 'Haiti'],
    ['338 366 367 368 369', 'United States'],
    ['339', 'Jamaica'],
    ['341', 'Saint Kitts and Nevis'],
    ['343', 'Saint Lucia'],
    ['345', 'Mexico'],
    ['347', 'France (Martinique)'],
    ['348', 'United Kingdom (Montserrat)'],
    ['350', 'Nicaragua'],
    ['351 352 353 354 355 356 357 370 371 372 373 374', 'Panama'],
    ['358', 'United States (Puerto Rico)'],
    ['359', 'El Salvador'],
    ['361', 'France (Saint Pierre and Miquelon)'],
    ['362', 'Trinidad and Tobago'],
    ['364', 'United Kingdom (Turks and Caicos Islands)'],
    ['375 376 377', 'Saint Vincent and the Grenadines'],
    ['378', 'United Kingdom (British Virgin Islands)'],
    ['379', 'United States (US Virgin Islands)'],
    ['401', 'Afghanistan'],
    ['403', 'Saudi Arabia'],
    ['405', 'Bangladesh'],
    ['408', 'Bahrain'],
    ['410', 'Bhutan'],
    ['412 413 414', 'China'],
    ['416', 'Taiwan'],
    ['417', 'Sri Lanka'],
    ['419', 'India'],
    ['422', 'Iran'],
    ['423', 'Azerbaijan'],
    ['425', 'Iraq'],
    ['428', 'Israel'],
    ['431 432', 'Japan'],
    ['434', 'Turkmenistan'],
    ['436', 'Kazakhstan'],
    ['437', 'Uzbekistan'],
    ['438', 'Jordan'],
    ['440 441', 'Republic of Korea'],
    ['443', 'State of Palestine'],
    ['445', "Democratic People's Republic of Korea"],
    ['447', 'Kuwait'],
    ['450', 'Lebanon'],
    ['451', 'Kyrgyzstan'],
    ['453', 'China (Macao)'],
    ['455', 'Maldives'],
    ['457', 'Mongolia'],
    ['459', 'Nepal'],
    ['461', 'Oman'],
    ['463', 'Pakistan'],
    ['466', 'Qatar'],
    ['468', 'Syria'],
    ['470 471', 'United Arab Emirates'],
    ['472', 'Tajikistan'],
    ['473 475', 'Yemen'],
    ['477', 'China (Hong Kong)'],
    ['478', 'Bosnia and Herzegovina'],
    ['501', 'France (Adélie Land)'],
    ['503', 'Australia'],
    ['506', 'Myanmar'],
    ['508', 'Brunei'],
    ['510', 'Micronesia'],
    ['511', 'Palau'],
    ['512', 'New Zealand'],
    ['514 515', 'Cambodia'],
    ['516', 'Australia (Christmas Island)'],
    ['518', 'New Zealand (Cook Islands)'],
    ['520', 'Fiji'],
    ['523', 'Australia (Cocos (Keeling) Islands)'],
    ['525', 'Indonesia'],
    ['529', 'Kiribati'],
    ['531', 'Laos'],
    ['533', 'Malaysia'],
    ['536', 'United States (Northern Mariana Islands)'],
    ['538', 'Marshall Islands'],
    ['540', 'France (New Caledonia)'],
    ['542', 'New Zealand (Niue)'],
    ['544', 'Nauru'],
    ['546', 'France (French Polynesia)'],
    ['548', 'Philippines'],
    ['550', 'Timor-Leste'],
    ['553', 'Papua New Guinea'],
    ['555', 'United Kingdom (Pitcairn Island)'],
    ['557', 'Solomon Islands'],
    ['559', 'United States (American Samoa)'],
    ['561', 'Samoa'],
    ['563 564 565 566', 'Singapore'],
    ['567', 'Thailand'],
    ['570', 'Tonga'],
    ['572', 'Tuvalu'],
    ['574', 'Viet Nam'],
    ['576 577', 'Vanuatu'],
    ['578', 'France (Wallis and Futuna)'],
    ['601', 'South Africa'],
    ['603', 'Angola'],
    ['605', 'Algeria'],
    ['607', 'France (Saint Paul and Amsterdam Islands)'],
    ['608', 'United Kingdom (Ascension Island)'],
    ['609', 'Burundi'],
    ['610', 'Benin'],
    ['611', 'Botswana'],
    ['612', 'Central African Republic'],
    ['613', 'Cameroon'],
    ['615', 'Congo'],
    ['616 620', 'Comoros'],
    ['617', 'Cabo Verde'],
    ['618', 'France (Crozet Archipelago)'],
    ['619', "Côte d'Ivoire"],
    ['621', 'Djibouti'],
    ['622', 'Egypt'],
    ['624', 'Ethiopia'],
    ['625', 'Eritrea'],
    ['626', 'Gabon'],
    ['627', 'Ghana'],
    ['629', 'Gambia'],
    ['630', 'Guinea-Bissau'],
    ['631', 'Equatorial Guinea'],
    ['632', 'Guinea'],
    ['633', 'Burkina Faso'],
    ['634', 'Kenya'],
    ['635', 'France (Kerguelen Islands)'],
    ['636 637', 'Liberia'],
    ['638', 'South Sudan'],
    ['642', 'Libya'],
    ['644', 'Lesotho'],
    ['645', 'Mauritius'],
    ['647', 'Madagascar'],
    ['649', 'Mali'],
    ['650', 'Mozambique'],
    ['654', 'Mauritania'],
    ['655', 'Malawi'],
    ['656', 'Niger'],
    ['657', 'Nigeria'],
    ['659', 'Namibia'],
    ['660', 'France (Réunion)'],
    ['661', 'Rwanda'],
    ['662', 'Sudan'],
    ['663', 'Senegal'],
    ['664', 'Seychelles'],
    ['665', 'United Kingdom (Saint Helena)'],
    ['666', 'Somalia'],
    ['667', 'Sierra Leone'],
    ['668', 'Sao Tome and Principe'],
    ['669', 'Eswatini'],
    ['670', 'Chad'],
    ['671', 'Togo'],
    ['672', 'Tunisia'],
    ['674 677', 'Tanzania'],
    ['675', 'Uganda'],
    ['676', 'Democratic Republic of the Congo'],
    ['678', 'Zambia'],
    ['679', 'Zimbabwe'],
    ['701', 'Argentina'],
    ['710', 'Brazil'],
    ['720', 'Bolivia'],
    ['725', 'Chile'],
    ['730', 'Colombia'],
    ['735', 'Ecuador'],
    ['740', 'United Kingdom (Falkland Islands)'],
    ['745', 'France (French Guiana)'],
    ['750', 'Guyana'],
    ['755', 'Paraguay'],
    ['760', 'Peru'],
    ['765', 'Suriname'],
    ['770', 'Uruguay'],
    ['775', 'Venezuela'],
  ];
  const out: Record<string, string> = {};
  for (const [mids, country] of rows) for (const mid of mids.split(' ')) out[mid] = country;
  return out;
}

/**
 * What an MMSI says about the station's kind and flag, or undefined for anything that is not
 * nine digits (or is all zeros).
 */
export function mmsiFlag(mmsi: string | number): MmsiFlag | undefined {
  const s =
    typeof mmsi === 'number' ? (Number.isInteger(mmsi) && mmsi > 0 ? String(mmsi).padStart(9, '0') : '') : mmsi.trim();
  if (!/^\d{9}$/.test(s) || /^0+$/.test(s)) return undefined;
  const withMid = (kind: MmsiStationKind, mid: string): MmsiFlag => {
    const country = MID_ALLOCATIONS[mid];
    return country ? { kind, mid, country } : { kind, mid };
  };
  if (/^97[024]/.test(s)) return { kind: 'emergency-device' };
  if (s.startsWith('111')) return withMid('sar-aircraft', s.slice(3, 6));
  if (s.startsWith('98')) return withMid('associated-craft', s.slice(2, 5));
  if (s.startsWith('99')) return withMid('aid-to-navigation', s.slice(2, 5));
  if (s.startsWith('00')) return withMid('coast-station', s.slice(2, 5));
  if (s.startsWith('0')) return withMid('group', s.slice(1, 4));
  if (s.startsWith('8')) return withMid('handheld', s.slice(1, 4));
  if (/^[2-7]/.test(s)) return withMid('ship', s.slice(0, 3));
  return undefined;
}
