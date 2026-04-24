import { useCallback, useEffect, useState } from 'react';
import { fetchSkills, disableSkill, enableSkill, type SkillInfo } from '../api';

export function SkillsPanel() {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setSkills(await fetchSkills());
      setError('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleToggle = async (skill: SkillInfo) => {
    try {
      if (skill.source === 'system') {
        await disableSkill(skill.id);
      } else {
        await enableSkill(skill.id);
      }
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (loading) return <p className="manage__empty">Loading...</p>;
  if (error) return <p className="manage__error">{error}</p>;
  if (skills.length === 0) return <p className="manage__empty">No skills configured.</p>;

  return (
    <div className="manage__list">
      {skills.map((s) => (
        <div className="manage__card" key={s.id}>
          <div className="manage__card-info">
            <div className="manage__card-header">
              <span className="manage__card-name">{s.name}</span>
              <span className={`manage__badge manage__badge--${s.source}`}>{s.source}</span>
            </div>
            <div className="manage__card-desc">{s.description}</div>
          </div>
          <div className="manage__card-actions">
            <button className="btn btn--sm btn--ghost" onClick={() => void handleToggle(s)}>
              {s.source === 'system' ? 'Disable' : 'Enable'}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
