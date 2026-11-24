import type { ProjectSelection } from '../../shared/desktop-api.js';

export function ProjectPicker(props: { projects: ProjectSelection[]; activePath: string | null; disabled?: boolean; onOpen(project: ProjectSelection): void }) {
  return (
    <section className="sidebar-section">
      <div className="section-heading">最近项目</div>
      {props.projects.length === 0
        ? <div className="sidebar-empty">还没有打开过项目</div>
        : props.projects.map((project) => (
          <button key={project.path} className={`list-row ${props.activePath === project.path ? 'selected' : ''}`} disabled={props.disabled} onClick={() => props.onOpen(project)} title={project.path}>
            <span className="folder-icon">▱</span><span className="list-row-label">{project.name}</span>
          </button>
        ))}
    </section>
  );
}
