import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareAnswers, parseAnswerToNumber } from './answerUtils.js';

test('requires the specified representation without approximate matching', () => {
  assert(compareAnswers('1/4', '1/4', undefined, 'reduced_fraction'));
  assert(!compareAnswers('2/8', '1/4', undefined, 'reduced_fraction'));
  assert(!compareAnswers('0.25', '1/4', undefined, 'reduced_fraction'));
  assert(!compareAnswers('1/4000', '1/4', undefined, 'reduced_fraction'));
  assert(!compareAnswers('25.0', '25', undefined, 'integer'));
  assert(compareAnswers('2.50', '2.50', undefined, 'fixed_decimal', 2));
  assert(!compareAnswers('2.5', '2.50', undefined, 'fixed_decimal', 2));
  assert(!compareAnswers('0.0011', '0.0010', undefined, 'fixed_decimal', 4));
  assert(compareAnswers('2.5 × 10^3', '2.5e3', undefined, 'scientific'));
  assert(!compareAnswers('25e2', '2.5e3', undefined, 'scientific'));
  assert(!compareAnswers('5.001e-12', '5e-12', undefined, 'scientific'));
});

test('supports legacy numeric, radical, ordered-pair and text grading', () => {
  assert(compareAnswers('0.25', '1/4'));
  assert(compareAnswers('2√3', 'sqrt(12)'));
  assert(compareAnswers('(1/2,-3)', '(0.5,-3)'));
  assert(compareAnswers('(1/2,-3)', '"(0.5,-3)"', undefined, 'equivalent'));
  assert(compareAnswers('Saturday', 'Saturday'));
  assert(compareAnswers('Saturday', '"Saturday"', undefined, 'exact_text'));
  assert.equal(parseAnswerToNumber('2+3*4'), 14);
  assert.equal(parseAnswerToNumber('sin(0)'), 0);
  assert(compareAnswers('sin(0)', '0', undefined, null));
  assert(!compareAnswers('sin(0)', '0', undefined, 'exact_value'));
});

test('grades contest answer units, mixed numbers, exact values and accepted alternatives', () => {
  assert(compareAnswers('5 1/4 hours', '5 1/4', undefined, 'mixed_number', null, 'hours'));
  assert(!compareAnswers('5 2/8', '5 1/4', undefined, 'mixed_number'));
  assert(!compareAnswers('5.25', '5 1/4', undefined, 'mixed_number'));
  assert(compareAnswers('B', 'Blue or B', undefined, 'one_of'));
  assert(compareAnswers('$26.00', '26 or 26.00', undefined, 'one_of', null, '$'));
  assert(!compareAnswers('$26.0', '26 or 26.00', undefined, 'one_of', null, '$'));
  assert(compareAnswers('80%', '80', undefined, 'integer', null, '%'));
  assert(!compareAnswers('0.8', '80', undefined, 'integer', null, '%'));
  assert(compareAnswers('Floor 18', '18', undefined, 'integer', null, 'Floor'));
  assert(compareAnswers('3cbrt(450)', '3∛450', undefined, 'exact_value'));
  assert(compareAnswers('32π√3', '32π × √3', undefined, 'exact_value'));
  assert(!compareAnswers('22.989', '3∛450', undefined, 'exact_value'));
});
