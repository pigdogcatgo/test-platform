// Independently authored fictional questions for the isolated preview database.
// Nothing in this fixture is imported from OPLET or a real contest archive.
export const DEMO_CATALOG = [
  { topic: 'Algebra', question: 'If 3x + 7 = 28, what is x?', answer: '7', difficulty: 1, yearBlock: 'Demo Block A (2020–2024)', formats: ['Sprint', 'Target', 'Team', 'Countdown'] },
  { topic: 'Algebra', question: 'If 2a - 5 = 17, what is a?', answer: '11', difficulty: 1, yearBlock: 'Demo Block A (2020–2024)', formats: ['Sprint', 'Target', 'Countdown'] },
  { topic: 'Algebra', question: 'The sum of four consecutive integers is 74. What is the greatest integer?', answer: '20', difficulty: 2, yearBlock: 'Demo Block A (2020–2024)', formats: ['Sprint', 'Target', 'Team'] },
  { topic: 'Algebra', question: 'If x/3 + 4 = 10, what is x?', answer: '18', difficulty: 2, yearBlock: 'Demo Block B (2025–2029)', formats: ['Sprint', 'Target', 'Team'] },
  { topic: 'Algebra', question: 'If 5(y - 2) = 3y + 8, what is y?', answer: '9', difficulty: 3, yearBlock: 'Demo Block B (2025–2029)', formats: ['Sprint', 'Target', 'Team', 'Countdown'] },

  { topic: 'Arithmetic', question: 'What is 18 × 7?', answer: '126', difficulty: 1, yearBlock: 'Demo Block A (2020–2024)', formats: ['Sprint', 'Target', 'Team', 'Countdown'] },
  { topic: 'Arithmetic', question: 'What is 35% of 240?', answer: '84', difficulty: 2, yearBlock: 'Demo Block A (2020–2024)', formats: ['Sprint', 'Target', 'Team'] },
  { topic: 'Arithmetic', question: 'A notebook costs $3.25. What is the cost of 8 notebooks in dollars?', answer: '26', difficulty: 2, yearBlock: 'Demo Block B (2025–2029)', formats: ['Sprint', 'Target', 'Countdown'] },
  { topic: 'Arithmetic', question: 'What is 7/12 + 5/18? Express your answer as a reduced fraction.', answer: '31/36', difficulty: 3, yearBlock: 'Demo Block B (2025–2029)', formats: ['Sprint', 'Target', 'Team'] },
  { topic: 'Arithmetic', question: 'A number is increased by 20% and becomes ninety-six. What was the original number?', answer: '80', difficulty: 3, yearBlock: 'Demo Block C (2030–2034)', formats: ['Sprint', 'Team', 'Countdown'] },

  { topic: 'Counting & Probability', question: 'How many two-digit positive integers have identical digits?', answer: '9', difficulty: 1, yearBlock: 'Demo Block A (2020–2024)', formats: ['Sprint', 'Target', 'Countdown'] },
  { topic: 'Counting & Probability', question: 'A fair six-sided die is rolled once. What is the probability of rolling a prime number? Express your answer as a reduced fraction.', answer: '1/2', difficulty: 2, yearBlock: 'Demo Block A (2020–2024)', formats: ['Sprint', 'Target', 'Team'] },
  { topic: 'Counting & Probability', question: 'How many different two-letter arrangements can be made from A, B, C, and D without repeating a letter?', answer: '12', difficulty: 2, yearBlock: 'Demo Block B (2025–2029)', formats: ['Sprint', 'Target', 'Team', 'Countdown'] },
  { topic: 'Counting & Probability', question: 'A bag has 3 red and 5 blue tiles. Two tiles are drawn without replacement. What is the probability both are red? Express your answer as a reduced fraction.', answer: '3/28', difficulty: 4, yearBlock: 'Demo Block B (2025–2029)', formats: ['Sprint', 'Team'] },
  { topic: 'Counting & Probability', question: 'How many ways can 5 different books be arranged on a shelf if two particular books must be next to each other?', answer: '48', difficulty: 4, yearBlock: 'Demo Block C (2030–2034)', formats: ['Sprint', 'Team', 'Countdown'] },

  { topic: 'Geometry', question: 'A rectangle has side lengths 9 cm and 4 cm. What is its area in square centimeters?', answer: '36', difficulty: 1, yearBlock: 'Demo Block A (2020–2024)', formats: ['Sprint', 'Target', 'Team', 'Countdown'] },
  { topic: 'Geometry', question: 'Two angles of a triangle measure 48° and 67°. How many degrees measure the third angle?', answer: '65', difficulty: 1, yearBlock: 'Demo Block A (2020–2024)', formats: ['Sprint', 'Target'] },
  { topic: 'Geometry', question: 'A circle has radius 5 cm. What is the coefficient of π in its circumference, measured in centimeters?', answer: '10', difficulty: 2, yearBlock: 'Demo Block B (2025–2029)', formats: ['Sprint', 'Target', 'Team'] },
  { topic: 'Geometry', question: 'A right triangle has legs of lengths 8 and 15. What is the length of its hypotenuse?', answer: '17', difficulty: 2, yearBlock: 'Demo Block B (2025–2029)', formats: ['Sprint', 'Target', 'Countdown'] },
  { topic: 'Geometry', question: 'A cube has volume 216 cubic centimeters. What is its surface area in square centimeters?', answer: '216', difficulty: 3, yearBlock: 'Demo Block C (2030–2034)', formats: ['Sprint', 'Team', 'Countdown'] },

  { topic: 'Number Theory', question: 'What is the greatest common divisor of 84 and 126?', answer: '42', difficulty: 1, yearBlock: 'Demo Block A (2020–2024)', formats: ['Sprint', 'Target', 'Team'] },
  { topic: 'Number Theory', question: 'What is the least common multiple of 12 and 18?', answer: '36', difficulty: 1, yearBlock: 'Demo Block A (2020–2024)', formats: ['Sprint', 'Target', 'Countdown'] },
  { topic: 'Number Theory', question: 'How many positive divisors does 72 have?', answer: '12', difficulty: 3, yearBlock: 'Demo Block B (2025–2029)', formats: ['Sprint', 'Target', 'Team'] },
  { topic: 'Number Theory', question: 'What is the remainder when 7^4 is divided by 10?', answer: '1', difficulty: 2, yearBlock: 'Demo Block B (2025–2029)', formats: ['Sprint', 'Team', 'Countdown'] },
  { topic: 'Number Theory', question: 'What is the smallest positive integer divisible by 8, 9, and 15?', answer: '360', difficulty: 3, yearBlock: 'Demo Block C (2030–2034)', formats: ['Sprint', 'Team'] },

  { topic: 'Prealgebra', question: 'A car travels 150 kilometers in 3 hours at a constant speed. What is its speed in kilometers per hour?', answer: '50', difficulty: 1, yearBlock: 'Demo Block A (2020–2024)', formats: ['Sprint', 'Target', 'Team'] },
  { topic: 'Prealgebra', question: 'The average of 8, 11, 14, and n is 12. What is n?', answer: '15', difficulty: 2, yearBlock: 'Demo Block A (2020–2024)', formats: ['Sprint', 'Target', 'Countdown'] },
  { topic: 'Prealgebra', question: 'A map uses a scale of 1 cm to 6 km. Two towns are 7.5 cm apart on the map. How many kilometers apart are they?', answer: '45', difficulty: 2, yearBlock: 'Demo Block B (2025–2029)', formats: ['Sprint', 'Target', 'Team'] },
  { topic: 'Prealgebra', question: 'A tank is 3/5 full. After 24 liters are added, it is 9/10 full. What is the tank capacity in liters?', answer: '80', difficulty: 4, yearBlock: 'Demo Block B (2025–2029)', formats: ['Sprint', 'Team', 'Countdown'] },
  { topic: 'Prealgebra', question: 'The ratio of cats to dogs at a shelter is 4:7. There are 33 animals total. How many are dogs?', answer: '21', difficulty: 2, yearBlock: 'Demo Block C (2030–2034)', formats: ['Sprint', 'Target', 'Team'] },
];
