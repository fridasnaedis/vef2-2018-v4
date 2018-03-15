require('dotenv').config();
require('isomorphic-fetch');
const cheerio = require('cheerio');
const redis = require('redis');
const util = require('util');

const {
  REDIS_URL,
  REDIS_EXPIRE,
} = process.env;

const redisOptions = {
  url: REDIS_URL,
};

const client = redis.createClient(redisOptions);

const asyncGet = util.promisify(client.get).bind(client);
const asyncSet = util.promisify(client.set).bind(client);

/**
 * Listi af sviðum með „slug“ fyrir vefþjónustu og viðbættum upplýsingum til
 * að geta sótt gögn.
 */
const departments = [
  {
    name: 'Félagsvísindasvið',
    slug: 'felagsvisindasvid',
    id: 1,
  },
  {
    name: 'Heilbrigðisvísindasvið',
    slug: 'heilbrigdisvisindasvid',
    id: 2,
  },
  {
    name: 'Hugvísindasvið',
    slug: 'hugvisindasvid',
    id: 3,
  },
  {
    name: 'Menntavísindasvið',
    slug: 'menntavisindasvid',
    id: 4,
  },
  {
    name: 'Verkfræði- og náttúruvísindasvið',
    slug: 'verkfraedi-og-natturuvisindasvid',
    id: 5,
  },
];

/**
 * Sækir svið eftir `slug`. Fáum gögn annaðhvort beint frá vef eða úr cache.
 *
 * @param {string} slug - Slug fyrir svið sem skal sækja
 * @returns {Promise} Promise sem mun innihalda gögn fyrir svið eða null ef það finnst ekki
 */
async function getTests(slug) {
  const cached = await asyncGet(slug);
  let text = '';
  if (!cached) {
    // Finnum id út frá slug til að ná í gögn
    const currDepartment = departments.filter(department => department.slug === slug)[0];
    // Ef svið er ekki til
    if (!currDepartment) return null;
    const response = await fetch(`https://ugla.hi.is/Proftafla/View/ajax.php?sid=2027&a=getProfSvids&proftaflaID=37&svidID=${currDepartment.id}&notaVinnuToflu=0`);
    text = await response.text();
    await asyncSet(slug, text, 'EX', REDIS_EXPIRE);
  } else {
    text = cached;
  }
  const $ = cheerio.load(JSON.parse(text).html);
  const tests = [];
  // Finnum lista af deildum
  const faculties = $('.box h3');
  faculties.each((i, el) => {
    const faculty = $(el);
    const table = faculty.next();
    // Finnum öll próf/áfanga innan deildar
    const testsInfo = table.find('tbody tr');
    const testsInfoObjects = [];
    testsInfo.each((i2, el2) => {
      const testInfo = $(el2).find('td');
      const testInfoObject = {
        course: testInfo.eq(0).text(),
        name: testInfo.eq(1).text(),
        type: testInfo.eq(2).text(),
        students: testInfo.eq(3).text(),
        date: testInfo.eq(4).text(),
      };
      testsInfoObjects.push(testInfoObject);
    });
    tests.push({ heading: faculty.text().trim(), tests: testsInfoObjects });
  });
  return tests;
}

/**
 * Hreinsar cache.
 *
 * @returns {Promise} Promise sem mun innihalda boolean um hvort cache hafi verið hreinsað eða ekki.
 */
async function clearCache() {
  try {
    const response = await client.flushall();
    return response;
  } catch (error) {
    return false;
  }
}

/**
 * Sækir tölfræði fyrir öll próf allra deilda allra sviða.
 *
 * @returns {Promise} Promise sem mun innihalda object með tölfræði um próf
 */
async function getStats() {
  // Frumstillum breytur
  let totalTests = 0;
  let totalTestTakings = 0;
  let minTestTakers = Number.POSITIVE_INFINITY;
  let maxTestTakers = Number.NEGATIVE_INFINITY;
  // Sækjum öll svið
  const deptSlugs = departments.map(department => department.slug);

  const getDepartmentData = deptSlugs.map(async (slug) => {
    const departmentData = await getTests(slug);
    return departmentData;
  });

  const result = await Promise.all(getDepartmentData);

  result.forEach((currDept) => {
    currDept.forEach((currFaculty) => {
      currFaculty.tests.forEach((currCourse) => {
        const numTestTakers = parseInt(currCourse.students, 10);
        totalTests += 1;
        totalTestTakings += numTestTakers;
        if (numTestTakers > maxTestTakers) {
          maxTestTakers = numTestTakers;
        }

        if (numTestTakers < minTestTakers) {
          minTestTakers = numTestTakers;
        }
      });
    });
  });
  const averageTestTakers = totalTestTakings / totalTests;
  const stats = {
    min: minTestTakers,
    max: maxTestTakers,
    numTests: totalTests,
    numStudents: totalTestTakings,
    averageStudents: averageTestTakers.toFixed(2) - 0,
  };
  return stats;
}

module.exports = {
  departments,
  getTests,
  clearCache,
  getStats,
};
