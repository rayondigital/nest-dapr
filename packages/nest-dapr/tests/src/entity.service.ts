import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class EntityService {
  private readonly entities: Map<string, Entity> = new Map();
  public async get(id: string): Promise<Entity> {
    const entity = this.entities.get(id);
    if (!entity) {
      throw new Error(`Entity with id ${id} not found`);
    }
    return entity;
  }

  public async update(entity: Entity): Promise<void> {
    this.entities.set(entity.id, entity);
  }

  public async delete(id: string): Promise<void> {
    this.entities.delete(id);
  }

  public async clear(): Promise<void> {
    this.entities.clear();
  }

  public async getAll(): Promise<Entity[]> {
    return Array.from(this.entities.values());
  }

  public async query(predicate: (entity: Entity) => boolean): Promise<Entity[]> {
    const all = await this.getAll();
    return all.filter(predicate);
  }
}

export interface Entity {
  id: string;
  status: string;
  createdAt: Date;
  lastUpdatedAt: Date;
  data: any;
}
