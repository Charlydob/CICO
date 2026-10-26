export const LANGUAGES: string[];
export const LIMITS: Record<string,number>;
export const TEXT_KEYS: string[];
export interface Theme {schemaVersion:number;width:number;height:number;hotelName:string;template:string;font:string;defaultLanguage:string;colors:Record<string,string>;qr:{enabled:boolean;data:string;size:number};logo:string|null;background:string|null;idleMs:number;returnMs:number;texts:Record<string,Record<string,string>>;}
export function defaultTheme(name?:string):Theme;
export function upgradeTheme(raw:unknown):Theme;
export function validateTheme(raw:unknown):Theme;
export const GEOMETRY:{[key:string]:any; rows:string[];accentKeys:string[];symbolKeys:string[];};
