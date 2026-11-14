"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {creativeNotes,HEADER}=require("../src/company-assistant/creative-brief");
test("existing campaigns without a creative request retain their exact receiver contract",()=>{
  assert.equal(creativeNotes(undefined,undefined),undefined);assert.equal(creativeNotes("",""),undefined);
});
test("notes retain both the analyzed direction and the actual customer request",()=>{
  const source="Só adicione a logo e o preço de 43,67; mantenha minha foto.",direction="Preservar foto e cenário; aplicar somente logo e o texto autorizado.";
  const notes=creativeNotes(source,direction);assert(notes.startsWith(HEADER));assert(notes.includes(direction));assert(notes.includes(source));assert(notes.length<=1700);
});
test("long original requests keep the full analyzed brief within the existing note limit",()=>{
  const direction="Fundo verde-escuro, logo pequena no canto direito e preservar o lanche.";
  const notes=creativeNotes("Texto extenso ".repeat(140),direction);assert(notes.includes(direction));assert(notes.length<=1700);
});
