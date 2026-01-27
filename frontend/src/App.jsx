import React, { useState, useEffect, useCallback, useMemo } from 'react';
import axios from 'axios';
import { API_URL } from './config';
import './index.css';
import 'katex/dist/katex.min.css';
import { InlineMath, BlockMath } from 'react-katex';

const App = () => {
  const [token, setToken] = useState(() => localStorage.getItem('token'));
  const [user, setUser] = useState(null);
  const [view, setView] = useState('login');
  const [loginForm, setLoginForm] = useState({ username: '', password: '' });
  const [showPassword, setShowPassword] = useState(false);
  
  const [problems, setProblems] = useState([]);
  const [tests, setTests] = useState([]);
  const [attempts, setAttempts] = useState([]);
  const [students, setStudents] = useState([]);
  
  const [activeTest, setActiveTest] = useState(null);
  const [testProblems, setTestProblems] = useState([]);
  const [testAnswers, setTestAnswers] = useState({});
  const [timeRemaining, setTimeRemaining] = useState(null);
  
  const [editingProblem, setEditingProblem] = useState(null);
  const [newTest, setNewTest] = useState({ name: '', problemIds: [], dueDate: '', timeLimit: 30 });
  const [selectedTestAnalytics, setSelectedTestAnalytics] = useState(null);

  // Create axios instance with useMemo to prevent recreation on every render
  const api = useMemo(() => {
    return axios.create({
      baseURL: API_URL,
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    });
  }, [token]);

  const handleLogout = useCallback(() => {
    localStorage.removeItem('token');
    setToken(null);
    setUser(null);
    setView('login');
    setActiveTest(null);
  }, []);

  const loadUserData = useCallback(async () => {
    try {
      const { data: userData } = await api.get('/api/me');
      setUser(userData);
      
      if (userData.role === 'student') {
        setView('student-dashboard');
        const [testsRes, attemptsRes] = await Promise.all([
          api.get('/api/tests'),
          api.get('/api/attempts')
        ]);
        setTests(testsRes.data);
        setAttempts(attemptsRes.data);
      } else if (userData.role === 'teacher') {
        setView('teacher-dashboard');
        const [problemsRes, testsRes, studentsRes] = await Promise.all([
          api.get('/api/problems'),
          api.get('/api/tests'),
          api.get('/api/students')
        ]);
        setProblems(problemsRes.data);
        setTests(testsRes.data);
        setStudents(studentsRes.data);
      } else if (userData.role === 'admin') {
        setView('admin-dashboard');
        const { data: problemsData } = await api.get('/api/problems');
        setProblems(problemsData);
      }
    } catch (error) {
      console.error('Error loading user data:', error);
      handleLogout();
    }
  }, [api, handleLogout]);

  const handleSubmitTest = useCallback(async () => {
    if (!activeTest) return;
    
    try {
      const { data } = await api.post(`/api/tests/${activeTest.id}/submit`, { answers: testAnswers });
      alert(`Test submitted! Score: ${data.attempt.score}/${data.attempt.total}\nELO Change: ${data.eloChange >= 0 ? '+' : ''}${data.eloChange}`);
      
      setActiveTest(null);
      setTestAnswers({});
      setTimeRemaining(null);
      loadUserData();
    } catch (error) {
      alert(error.response?.data?.error || 'Error submitting test');
    }
  }, [activeTest, testAnswers, api, loadUserData]);

  // Timer effect with proper dependencies
  useEffect(() => {
    if (timeRemaining !== null && timeRemaining > 0 && activeTest) {
      const timer = setTimeout(() => setTimeRemaining(timeRemaining - 1), 1000);
      return () => clearTimeout(timer);
    } else if (timeRemaining === 0 && activeTest) {
      handleSubmitTest();
    }
  }, [timeRemaining, activeTest, handleSubmitTest]);

  // Load user data when token changes
  useEffect(() => {
    if (token) {
      loadUserData();
    }
  }, [token, loadUserData]);

  const handleLogin = async (e) => {
    e.preventDefault();
    try {
      const { data } = await axios.post(`${API_URL}/api/login`, loginForm);
      localStorage.setItem('token', data.token);
      setToken(data.token);
      setUser(data.user);
    } catch (error) {
      alert('Invalid credentials');
    }
  };

  const RenderLatex = ({ text }) => {
    if (!text) return null;
    
    const parts = [];
    let lastIndex = 0;
    
    // Match both inline $...$ and display $$...$$ LaTeX
    const regex = /\$\$(.+?)\$\$|\$(.+?)\$/g;
    let match;
    
    while ((match = regex.exec(text)) !== null) {
      // Add text before the match
      if (match.index > lastIndex) {
        parts.push(text.substring(lastIndex, match.index));
      }
      
      // Add the LaTeX part
      if (match[1]) {
        // Display math $$...$$
        parts.push(<BlockMath key={match.index} math={match[1]} />);
      } else if (match[2]) {
        // Inline math $...$
        parts.push(<InlineMath key={match.index} math={match[2]} />);
      }
      
      lastIndex = regex.lastIndex;
    }
    
    // Add remaining text
    if (lastIndex < text.length) {
      parts.push(text.substring(lastIndex));
    }
    
    return <>{parts}</>;
  };

  const startTest = async (test) => {
    const hasAttempt = attempts.find(a => a.test_id === test.id);
    if (hasAttempt) {
      alert('You have already completed this test');
      return;
    }

    try {
      const { data: problemsData } = await api.get('/api/problems');
      // Add defensive check for problem_ids
      const problemIds = test.problem_ids || [];
      const testProbs = problemIds.map(id => problemsData.find(p => p.id === id)).filter(Boolean);
      const shuffled = [...testProbs].sort(() => Math.random() - 0.5);
      
      setActiveTest(test);
      setTestProblems(shuffled);
      setTimeRemaining(test.time_limit * 60);
      setTestAnswers({});
      setView('taking-test');
    } catch (error) {
      alert('Error loading test');
    }
  };

  const createTest = async () => {
    if (!newTest.name || newTest.problemIds.length === 0 || !newTest.dueDate) {
      alert('Please fill in all fields');
      return;
    }

    try {
      await api.post('/api/tests', {
        name: newTest.name,
        problemIds: newTest.problemIds,
        dueDate: newTest.dueDate,
        timeLimit: newTest.timeLimit
      });
      setNewTest({ name: '', problemIds: [], dueDate: '', timeLimit: 30 });
      loadUserData();
      alert('Test created successfully!');
    } catch (error) {
      alert('Error creating test');
    }
  };

  const saveProblem = async () => {
    if (!editingProblem.question || editingProblem.answer === undefined) {
      alert('Please fill in all fields');
      return;
    }

    try {
      if (editingProblem.id) {
        await api.put(`/api/problems/${editingProblem.id}`, editingProblem);
      } else {
        await api.post('/api/problems', editingProblem);
      }
      setEditingProblem(null);
      loadUserData();
    } catch (error) {
      alert('Error saving problem');
    }
  };

  const deleteProblem = async (id) => {
    if (!window.confirm('Delete this problem?')) return;
    
    try {
      await api.delete(`/api/problems/${id}`);
      loadUserData();
    } catch (error) {
      alert('Error deleting problem');
    }
  };

  const loadTestAnalytics = async (testId) => {
    try {
      const { data } = await api.get(`/api/tests/${testId}/attempts`);
      setSelectedTestAnalytics({ testId, attempts: data });
    } catch (error) {
      alert('Error loading analytics');
    }
  };

  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

if (view === 'login') {
  return (
    <div className="login-page">
      {/* Logo */}
      <div className="logo">
        <span className="logo-text">DDMTP</span>
        <div className="logo-icon">
          <span />
          <span />
          <span />
          <span />
        </div>
      </div>

      {/* Login Card */}
      <div className="login-card">
        <h1>Login</h1>
        <p className="subtitle">Log in to take your test!</p>

        <form onSubmit={handleLogin}>
          <input
            type="text"
            placeholder="Username*"
            value={loginForm.username}
            onChange={(e) =>
              setLoginForm({ ...loginForm, username: e.target.value })
            }
            required
          />

          <div className="password-wrapper">
            <input
              type={showPassword ? 'text' : 'password'}
              placeholder="Password*"
              value={loginForm.password}
              onChange={(e) =>
                setLoginForm({ ...loginForm, password: e.target.value })
              }
              required
            />
            <button
              type="button"
              className="toggle-password"
              onClick={() => setShowPassword(!showPassword)}
              aria-label="Toggle password visibility"
            >
              👁
            </button>
          </div>


          <button type="submit" className="login-btn">
            Log in
          </button>
        </form>
      </div>

      {/* Sign up */}
      <div className="signup">
        New to the platform? <a href="#">Sign up</a>
      </div>

      {/* Footer */}
      <footer className="footer">
        <a href="#">Help</a>
      </footer>
    </div>
  );
}

if (view === 'taking-test' && activeTest) {
  return (
    <div className="min-h-screen bg-[#f5f7f8] flex justify-center">
      <div className="w-full max-w-4xl p-6">

        {/* Header */}
        <div className="sticky top-0 z-50 mb-6">
          <div className="bg-white rounded-xl shadow px-6 py-4 flex items-center justify-between">
            <div className="w-1/4" />
            <h2 className="text-xl font-semibold text-gray-800 text-center flex-1">
              {activeTest.name}
            </h2>
            <div className="w-1/4 flex justify-end">
              <div
                className={`px-4 py-2 rounded-lg font-semibold text-sm ${
                  timeRemaining < 60
                    ? 'bg-red-100 text-red-700'
                    : 'bg-[#e6f6f7] text-[#007f8f]'
                }`}
              >
                {formatTime(timeRemaining)}
              </div>
            </div>
          </div>
        </div>

        {/* Time warning */}
        {timeRemaining < 60 && (
          <div className="mb-4">
            <div className="bg-red-50 border border-red-200 text-red-700 px-6 py-4 rounded-xl text-center text-sm">
              Less than 1 minute remaining. Please submit soon.
            </div>
          </div>
        )}

        {/* Questions */}
        <div className="space-y-4">
          {testProblems.map((problem, index) => (
            <div key={problem.id} className="bg-white rounded-xl shadow p-6">
              <div className="mb-4">
                <span className="text-xs font-medium text-gray-500">
                  Question {index + 1} of {testProblems.length}
                </span>
                <h3 className="text-base font-semibold text-gray-800 mt-1">
                  <RenderLatex text={problem.question} />
                </h3>
              </div>

              <input
                type="number"
                step="any"
                value={testAnswers[problem.id] || ''}
                onChange={(e) =>
                  setTestAnswers({
                    ...testAnswers,
                    [problem.id]: e.target.value
                  })
                }
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:border-[#00A3AD] focus:outline-none text-center text-sm"
                placeholder="Enter your answer"
              />
            </div>
          ))}
        </div>

        {/* Submit */}
        <div className="mt-6">
          <button
            onClick={handleSubmitTest}
            className="w-full bg-[#007f8f] hover:bg-[#006b78] text-white py-3 rounded-lg font-semibold"
          >
            Submit Test
          </button>
        </div>
      </div>
    </div>
  );
}


if (view === 'student-dashboard' && user) {
  const availableTests = tests.filter(
    (t) => !attempts.find((a) => a.test_id === t.id)
  );

  return (
    <div className="min-h-screen bg-[#f5f7f8] flex justify-center">
      <div className="w-full max-w-6xl p-6">

        {/* Top Nav */}
        <div className="bg-white rounded-xl shadow mb-6 px-6 py-4 flex items-center justify-between">
          <div className="w-1/4" />
          <h1 className="text-xl font-semibold text-gray-800 text-center flex-1">
            Student Portal
          </h1>
          <div className="w-1/4 flex justify-end">
            <button
              onClick={handleLogout}
              className="text-sm text-[#007f8f] font-medium hover:underline"
            >
              Logout
            </button>
          </div>
        </div>

        {/* Welcome Card */}
        <div className="bg-white rounded-xl shadow p-6 mb-6 text-center">
          <h2 className="text-2xl font-semibold text-gray-800 mb-1">
            Welcome, {user.username}
          </h2>
          <p className="text-sm text-gray-500 mb-4">
            Here’s a snapshot of your progress
          </p>

          <div className="inline-flex flex-col items-center bg-[#e6f6f7] px-6 py-4 rounded-xl">
            <span className="text-xs text-gray-600 mb-1">Your ELO</span>
            <span className="text-4xl font-bold text-[#007f8f]">
              {user.elo}
            </span>
          </div>
        </div>

        {/* Content */}
        <div className="grid md:grid-cols-2 gap-6">

          {/* Available Tests */}
          <div>
            <h3 className="text-lg font-semibold mb-4 text-gray-800">
              Available Tests
            </h3>

            {availableTests.length === 0 ? (
              <div className="bg-white rounded-xl shadow p-6 text-gray-500 text-center">
                No tests available
              </div>
            ) : (
              <div className="space-y-3">
                {availableTests.map((test) => (
                  <div key={test.id} className="bg-white rounded-xl shadow p-4">
                    <h4 className="font-semibold text-gray-800 mb-1">
                      {test.name}
                    </h4>
                    <p className="text-sm text-gray-500 mb-3">
                      {(test.problem_ids || []).length} questions •{' '}
                      {test.time_limit} min
                    </p>
                    <button
                      onClick={() => startTest(test)}
                      className="w-full bg-[#007f8f] hover:bg-[#006b78] text-white py-2 rounded-lg text-sm font-medium"
                    >
                      Start Test
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Test History */}
          <div>
            <h3 className="text-lg font-semibold mb-4 text-gray-800">
              Test History
            </h3>

            {attempts.length === 0 ? (
              <div className="bg-white rounded-xl shadow p-6 text-gray-500 text-center">
                No completed tests
              </div>
            ) : (
              <div className="space-y-3">
                {attempts.map((attempt) => {
                  const test = tests.find(
                    (t) => t.id === attempt.test_id
                  );
                  const delta = attempt.elo_after - attempt.elo_before;

                  return (
                    <div
                      key={attempt.id}
                      className="bg-white rounded-xl shadow p-4"
                    >
                      <h4 className="font-semibold text-gray-800 mb-1">
                        {test?.name || 'Unknown Test'}
                      </h4>
                      <p className="text-sm text-gray-500">
                        Score: {attempt.score}/{attempt.total} (
                        {Math.round(
                          (attempt.score / attempt.total) * 100
                        )}
                        %)
                      </p>
                      <p
                        className={`text-sm font-medium ${
                          delta >= 0
                            ? 'text-green-600'
                            : 'text-red-600'
                        }`}
                      >
                        ELO {delta >= 0 ? '+' : ''}
                        {delta}
                      </p>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}


if (view === 'teacher-dashboard' && user) {
  return (
    <div className="min-h-screen bg-[#f5f7f8]">
      {/* Top Nav */}
      <div className="sticky top-0 z-50 bg-white shadow">
        <div className="max-w-7xl mx-auto px-6 py-4 flex justify-between items-center">
          <h1 className="text-lg font-semibold text-gray-800">
            Teacher Dashboard
          </h1>
          <button
            onClick={handleLogout}
            className="text-sm text-[#007f8f] font-medium hover:underline"
          >
            Logout
          </button>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-6 py-8">
        {/* Create test */}
        <button
          onClick={() => setView('create-test')}
          className="mb-6 bg-[#007f8f] hover:bg-[#006b78] text-white px-6 py-3 rounded-lg font-medium"
        >
          Create New Test
        </button>

        <div className="grid lg:grid-cols-2 gap-6">
          {/* Tests */}
          <div>
            <h2 className="text-lg font-semibold mb-4 text-gray-800">
              Your Tests
            </h2>

            {tests.length === 0 ? (
              <div className="bg-white rounded-xl shadow p-6 text-center text-gray-500">
                No tests created yet
              </div>
            ) : (
              <div className="space-y-3">
                {tests.map(test => (
                  <div key={test.id} className="bg-white rounded-xl shadow p-4">
                    <h3 className="font-medium text-gray-800 mb-1">
                      {test.name}
                    </h3>
                    <p className="text-sm text-gray-500 mb-3">
                      {(test.problem_ids || []).length} questions • {test.time_limit} min
                    </p>

                    <button
                      onClick={() => loadTestAnalytics(test.id)}
                      className="text-sm text-[#007f8f] font-medium hover:underline"
                    >
                      View Analytics →
                    </button>

                    {selectedTestAnalytics?.testId === test.id && (
                      <div className="mt-4 pt-4 border-t text-sm">
                        {selectedTestAnalytics.attempts.slice(0, 5).map((a, i) => (
                          <div key={a.id} className="flex justify-between mb-1">
                            <span>{i + 1}. {a.username}</span>
                            <span className="font-medium">{a.score}/{a.total}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Leaderboard */}
          <div>
            <h2 className="text-lg font-semibold mb-4 text-gray-800">
              Student Leaderboard
            </h2>

            <div className="bg-white rounded-xl shadow divide-y">
              {students.map((s, i) => (
                <div key={s.id} className="flex justify-between p-4">
                  <span className="font-medium">{i + 1}. {s.username}</span>
                  <span className="text-[#007f8f] font-semibold">{s.elo}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

if (view === 'create-test' && user) {
  return (
    <div className="min-h-screen bg-[#f5f7f8] flex justify-center">
      <div className="w-full max-w-4xl p-6">
        <div className="bg-white rounded-xl shadow p-6 mb-6 flex justify-between items-center">
          <button
            onClick={() => setView('teacher-dashboard')}
            className="text-sm text-[#007f8f] hover:underline"
          >
            ← Back
          </button>
          <h1 className="text-lg font-semibold text-gray-800">
            Create New Test
          </h1>
          <span />
        </div>

        <div className="bg-white rounded-xl shadow p-8 space-y-6">
          <input
            className="w-full border rounded-lg px-4 py-3"
            placeholder="Test name"
            value={newTest.name}
            onChange={(e) => setNewTest({ ...newTest, name: e.target.value })}
          />

          <div className="grid grid-cols-2 gap-4">
            <input
              type="date"
              className="border rounded-lg px-4 py-3"
              value={newTest.dueDate}
              onChange={(e) => setNewTest({ ...newTest, dueDate: e.target.value })}
            />
            <input
              type="number"
              className="border rounded-lg px-4 py-3"
              value={newTest.timeLimit}
              onChange={(e) =>
                setNewTest({ ...newTest, timeLimit: +e.target.value || 30 })
              }
            />
          </div>

          <div className="max-h-64 overflow-y-auto border rounded-lg p-4 space-y-2">
            {problems.map(p => (
              <label key={p.id} className="flex gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={newTest.problemIds.includes(p.id)}
                  onChange={(e) =>
                    setNewTest({
                      ...newTest,
                      problemIds: e.target.checked
                        ? [...newTest.problemIds, p.id]
                        : newTest.problemIds.filter(id => id !== p.id)
                    })
                  }
                />
                <RenderLatex text={p.question} />
              </label>
            ))}
          </div>

          <button
            onClick={createTest}
            className="w-full bg-[#007f8f] hover:bg-[#006b78] text-white py-3 rounded-lg font-medium"
          >
            Create Test
          </button>
        </div>
      </div>
    </div>
  );
}

if (view === 'admin-dashboard' && user) {
  return (
    <div className="min-h-screen bg-[#f5f7f8] flex justify-center">
      <div className="w-full max-w-6xl p-6">
        <div className="bg-white rounded-xl shadow p-4 mb-6 flex justify-between">
          <h1 className="font-semibold text-gray-800">Admin Portal</h1>
          <button
            onClick={handleLogout}
            className="text-sm text-[#007f8f] hover:underline"
          >
            Logout
          </button>
        </div>

        <button
          onClick={() => setEditingProblem({ question: '', answer: '', topic: '' })}
          className="mb-6 bg-[#007f8f] text-white px-6 py-3 rounded-lg"
        >
          Add Problem
        </button>

        <div className="bg-white rounded-xl shadow overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left">
              <tr>
                <th className="px-4 py-3">Question</th>
                <th className="px-4 py-3">Answer</th>
                <th className="px-4 py-3">Topic</th>
                <th className="px-4 py-3">ELO</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {problems.map(p => (
                <tr key={p.id} className="border-t">
                  <td className="px-4 py-3">
                    <RenderLatex text={p.question} />
                  </td>
                  <td className="px-4 py-3">{p.answer}</td>
                  <td className="px-4 py-3">{p.topic}</td>
                  <td className="px-4 py-3">{p.elo}</td>
                  <td className="px-4 py-3 space-x-2">
                    <button onClick={() => setEditingProblem(p)}>Edit</button>
                    <button onClick={() => deleteProblem(p.id)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}


return (
  <div className="min-h-screen bg-[#f5f7f8] flex items-center justify-center text-gray-500">
    Loading…
  </div>
);

};

export default App;
