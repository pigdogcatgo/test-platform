import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { API_URL } from './config';

const App = () => {
  const [token, setToken] = useState(localStorage.getItem('token'));
  const [user, setUser] = useState(null);
  const [view, setView] = useState('login');
  const [loginForm, setLoginForm] = useState({ username: '', password: '' });
  
  // Data states
  const [problems, setProblems] = useState([]);
  const [tests, setTests] = useState([]);
  const [attempts, setAttempts] = useState([]);
  const [students, setStudents] = useState([]);
  
  // Active test states
  const [activeTest, setActiveTest] = useState(null);
  const [testProblems, setTestProblems] = useState([]);
  const [testAnswers, setTestAnswers] = useState({});
  const [timeRemaining, setTimeRemaining] = useState(null);
  
  // Form states
  const [editingProblem, setEditingProblem] = useState(null);
  const [newTest, setNewTest] = useState({ name: '', problemIds: [], dueDate: '', timeLimit: 30 });
  const [selectedTestAnalytics, setSelectedTestAnalytics] = useState(null);

  // Timer effect
  useEffect(() => {
    if (timeRemaining !== null && timeRemaining > 0 && activeTest) {
      const timer = setTimeout(() => setTimeRemaining(timeRemaining - 1), 1000);
      return () => clearTimeout(timer);
    } else if (timeRemaining === 0 && activeTest) {
      handleSubmitTest();
    }
  }, [timeRemaining]);

  // Load user data on mount
  useEffect(() => {
    if (token) {
      loadUserData();
    }
  }, [token]);

  const api = axios.create({
    baseURL: API_URL,
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  });

  const loadUserData = async () => {
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
  };

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

  const handleLogout = () => {
    localStorage.removeItem('token');
    setToken(null);
    setUser(null);
    setView('login');
    setActiveTest(null);
  };

  const startTest = async (test) => {
    const hasAttempt = attempts.find(a => a.test_id === test.id);
    if (hasAttempt) {
      alert('You have already completed this test');
      return;
    }

    try {
      const { data: problemsData } = await api.get('/api/problems');
      const testProbs = test.problem_ids.map(id => problemsData.find(p => p.id === id));
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

  const handleSubmitTest = async () => {
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
    if (!confirm('Delete this problem?')) return;
    
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

  // Login View
  if (view === 'login') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4">
        <div className="bg-white rounded-lg shadow-xl p-8 w-full max-w-md">
          <h1 className="text-3xl font-bold text-center mb-6 text-gray-800">Test Platform</h1>
          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Username</label>
              <input
                type="text"
                value={loginForm.username}
                onChange={(e) => setLoginForm({ ...loginForm, username: e.target.value })}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
              <input
                type="password"
                value={loginForm.password}
                onChange={(e) => setLoginForm({ ...loginForm, password: e.target.value })}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              />
            </div>
            <button type="submit" className="w-full bg-indigo-600 text-white py-2 rounded-lg hover:bg-indigo-700">
              Login
            </button>
          </form>
          <div className="mt-6 text-sm text-gray-600 space-y-1">
            <p className="font-semibold">Demo accounts:</p>
            <p>Admin: admin / admin123</p>
            <p>Teacher: teacher1 / teacher123</p>
            <p>Student: student1 / student123</p>
          </div>
        </div>
      </div>
    );
  }

  // Taking Test View
  if (view === 'taking-test' && activeTest) {
    return (
      <div className="min-h-screen bg-gray-50 p-4">
        <div className="max-w-3xl mx-auto">
          <div className="bg-white rounded-lg shadow-lg p-6 mb-4">
            <div className="flex justify-between items-center">
              <h2 className="text-2xl font-bold">{activeTest.name}</h2>
              <div className={`text-xl font-mono font-bold ${timeRemaining < 60 ? 'text-red-600' : 'text-gray-700'}`}>
                {formatTime(timeRemaining)}
              </div>
            </div>
            {timeRemaining < 60 && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded mt-4">
                ⚠️ Less than 1 minute remaining!
              </div>
            )}
          </div>
          
          <div className="space-y-4">
            {testProblems.map((problem, index) => (
              <div key={problem.id} className="bg-white rounded-lg shadow p-6">
                <div className="mb-4">
                  <span className="text-sm font-medium text-gray-500">
                    Question {index + 1} of {testProblems.length}
                  </span>
                  <h3 className="text-lg font-medium text-gray-800 mt-1">{problem.question}</h3>
                </div>
                <input
                  type="number"
                  step="any"
                  value={testAnswers[problem.id] || ''}
                  onChange={(e) => setTestAnswers({ ...testAnswers, [problem.id]: e.target.value })}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg"
                  placeholder="Enter your answer"
                />
              </div>
            ))}
          </div>
          
          <button
            onClick={handleSubmitTest}
            className="w-full mt-6 bg-indigo-600 text-white py-3 rounded-lg hover:bg-indigo-700"
          >
            Submit Test
          </button>
        </div>
      </div>
    );
  }

  // Student Dashboard
  if (view === 'student-dashboard' && user) {
    const availableTests = tests.filter(t => !attempts.find(a => a.test_id === t.id));
    
    return (
      <div className="min-h-screen bg-gray-50">
        <nav className="bg-white shadow-sm border-b">
          <div className="max-w-7xl mx-auto px-4 py-4 flex justify-between items-center">
            <h1 className="text-xl font-bold">Student Portal</h1>
            <button onClick={handleLogout} className="text-gray-600 hover:text-gray-800">
              Logout
            </button>
          </div>
        </nav>
        
        <div className="max-w-7xl mx-auto p-6">
          <div className="bg-gradient-to-r from-indigo-600 to-purple-600 rounded-lg shadow-lg p-6 text-white mb-6">
            <div className="flex justify-between items-center">
              <div>
                <h2 className="text-3xl font-bold mb-2">Welcome, {user.username}!</h2>
                <p className="text-indigo-100">Keep up the great work</p>
              </div>
              <div className="text-center">
                <div className="text-sm font-medium mb-1">Your ELO</div>
                <div className="text-4xl font-bold">{user.elo}</div>
              </div>
            </div>
          </div>
          
          <div className="grid md:grid-cols-2 gap-6">
            <div>
              <h3 className="text-xl font-bold mb-4">Available Tests</h3>
              {availableTests.length === 0 ? (
                <div className="bg-white rounded-lg shadow p-6 text-center text-gray-500">
                  No tests available
                </div>
              ) : (
                <div className="space-y-3">
                  {availableTests.map(test => (
                    <div key={test.id} className="bg-white rounded-lg shadow p-4">
                      <h4 className="font-semibold mb-2">{test.name}</h4>
                      <div className="text-sm text-gray-600 mb-3 space-y-1">
                        <p>Questions: {test.problem_ids.length}</p>
                        <p>Time: {test.time_limit} min</p>
                        <p>Due: {new Date(test.due_date).toLocaleDateString()}</p>
                      </div>
                      <button
                        onClick={() => startTest(test)}
                        className="w-full bg-indigo-600 text-white py-2 rounded hover:bg-indigo-700"
                      >
                        Start Test
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            
            <div>
              <h3 className="text-xl font-bold mb-4">Test History</h3>
              {attempts.length === 0 ? (
                <div className="bg-white rounded-lg shadow p-6 text-center text-gray-500">
                  No completed tests
                </div>
              ) : (
                <div className="space-y-3">
                  {attempts.map(attempt => {
                    const test = tests.find(t => t.id === attempt.test_id);
                    return (
                      <div key={attempt.id} className="bg-white rounded-lg shadow p-4">
                        <h4 className="font-semibold mb-2">{test?.name}</h4>
                        <div className="text-sm text-gray-600 space-y-1">
                          <p>Score: {attempt.score}/{attempt.total} ({Math.round(attempt.score/attempt.total*100)}%)</p>
                          <p className={attempt.elo_after - attempt.elo_before >= 0 ? 'text-green-600' : 'text-red-600'}>
                            ELO: {attempt.elo_after - attempt.elo_before >= 0 ? '+' : ''}{attempt.elo_after - attempt.elo_before}
                          </p>
                        </div>
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

  // Teacher Dashboard
  if (view === 'teacher-dashboard' && user) {
    return (
      <div className="min-h-screen bg-gray-50">
        <nav className="bg-white shadow-sm border-b">
          <div className="max-w-7xl mx-auto px-4 py-4 flex justify-between items-center">
            <h1 className="text-xl font-bold">Teacher Portal</h1>
            <button onClick={handleLogout} className="text-gray-600 hover:text-gray-800">
              Logout
            </button>
          </div>
        </nav>
        
        <div className="max-w-7xl mx-auto p-6">
          <div className="grid lg:grid-cols-2 gap-6">
            <div>
              <h3 className="text-xl font-bold mb-4">Create New Test</h3>
              <div className="bg-white rounded-lg shadow p-6 space-y-4">
                <input
                  type="text"
                  value={newTest.name}
                  onChange={(e) => setNewTest({ ...newTest, name: e.target.value })}
                  className="w-full px-4 py-2 border rounded-lg"
                  placeholder="Test name"
                />
                <input
                  type="date"
                  value={newTest.dueDate}
                  onChange={(e) => setNewTest({ ...newTest, dueDate: e.target.value })}
                  className="w-full px-4 py-2 border rounded-lg"
                />
                <input
                  type="number"
                  value={newTest.timeLimit}
                  onChange={(e) => setNewTest({ ...newTest, timeLimit: parseInt(e.target.value) })}
                  className="w-full px-4 py-2 border rounded-lg"
                  placeholder="Time limit (minutes)"
                />
                <div className="max-h-48 overflow-y-auto border rounded-lg p-3">
                  {problems.map(prob => (
                    <label key={prob.id} className="flex items-center gap-2 mb-2">
                      <input
                        type="checkbox"
                        checked={newTest.problemIds.includes(prob.id)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setNewTest({ ...newTest, problemIds: [...newTest.problemIds, prob.id] });
                          } else {
                            setNewTest({ ...newTest, problemIds: newTest.problemIds.filter(id => id !== prob.id) });
                          }
                        }}
                      />
                      <span className="text-sm">{prob.question}</span>
                    </label>
                  ))}
                </div>
                <button onClick={createTest} className="w-full bg-indigo-600 text-white py-2 rounded">
                  Create Test
                </button>
              </div>
              
              <h3 className="text-xl font-bold mt-6 mb-4">Student Leaderboard</h3>
              <div className="bg-white rounded-lg shadow p-6">
                {students.map((student, idx) => (
                  <div key={student.id} className="flex justify-between py-2 border-b">
                    <span>#{idx + 1} {student.username}</span>
                    <span className="font-bold text-indigo-600">{student.elo}</span>
                  </div>
                ))}
              </div>
            </div>
            
            <div>
              <h3 className="text-xl font-bold mb-4">Test Analytics</h3>
              {tests.map(test => (
                <div key={test.id} className="bg-white rounded-lg shadow p-4 mb-4">
                  <h4 className="font-semibold mb-2">{test.name}</h4>
                  <button
                    onClick={() => loadTestAnalytics(test.id)}
                    className="text-indigo-600 text-sm hover:underline"
                  >
                    View Analytics
                  </button>
                  
                  {selectedTestAnalytics?.testId === test.id && (
                    <div className="mt-4 space-y-2">
                      <div>
                        <h5 className="text-sm font-medium mb-1">Top Performers:</h5>
                        {selectedTestAnalytics.attempts.slice(0, 5).map(a => (
                          <div key={a.id} className="text-sm text-gray-600">
                            {a.username} - {a.score}/{a.total}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Admin Dashboard
  if (view === 'admin-dashboard' && user) {
    return (
      <div className="min-h-screen bg-gray-50">
        <nav className="bg-white shadow-sm border-b">
          <div className="max-w-7xl mx-auto px-4 py-4 flex justify-between items-center">
            <h1 className="text-xl font-bold">Admin Portal</h1>
            <button onClick={handleLogout} className="text-gray-600 hover:text-gray-800">
              Logout
            </button>
          </div>
        </nav>
        
        <div className="max-w-7xl mx-auto p-6">
          <div className="flex justify-between mb-6">
            <h3 className="text-2xl font-bold">Problem Database</h3>
            <button
              onClick={() => setEditingProblem({ question: '', answer: '', topic: '' })}
              className="bg-indigo-600 text-white px-4 py-2 rounded"
            >
              Add Problem
            </button>
          </div>
          
          {editingProblem && (
            <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
              <div className="bg-white rounded-lg p-6 w-full max-w-md">
                <h4 className="text-xl font-bold mb-4">{editingProblem.id ? 'Edit' : 'Add'} Problem</h4>
                <div className="space-y-4">
                  <input
                    type="text"
                    value={editingProblem.question}
                    onChange={(e) => setEditingProblem({ ...editingProblem, question: e.target.value })}
                    className="w-full px-4 py-2 border rounded"
                    placeholder="Question"
                  />
                  <input
                    type="number"
                    step="any"
                    value={editingProblem.answer}
                    onChange={(e) => setEditingProblem({ ...editingProblem, answer: parseFloat(e.target.value) })}
                    className="w-full px-4 py-2 border rounded"
                    placeholder="Answer"
                  />
                  <input
                    type="text"
                    value={editingProblem.topic}
                    onChange={(e) => setEditingProblem({ ...editingProblem, topic: e.target.value })}
                    className="w-full px-4 py-2 border rounded"
                    placeholder="Topic"
                  />
                  <div className="flex gap-2">
                    <button onClick={saveProblem} className="flex-1 bg-indigo-600 text-white py-2 rounded">
                      Save
                    </button>
                    <button onClick={() => setEditingProblem(null)} className="flex-1 bg-gray-200 py-2 rounded">
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
          
          <div className="bg-white rounded-lg shadow overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Question</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Answer</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Topic</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">ELO</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {problems.map(prob => (
                  <tr key={prob.id}>
                    <td className="px-6 py-4 text-sm">{prob.question}</td>
                    <td className="px-6 py-4 text-sm">{prob.answer}</td>
                    <td className="px-6 py-4 text-sm">{prob.topic}</td>
                    <td className="px-6 py-4 text-sm font-semibold text-indigo-600">{prob.elo}</td>
                    <td className="px-6 py-4 text-sm space-x-2">
                      <button onClick={() => setEditingProblem(prob)} className="text-indigo-600">Edit</button>
                      <button onClick={() => deleteProblem(prob.id)} className="text-red-600">Delete</button>
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

  return <div>Loading...</div>;
};

export default App;