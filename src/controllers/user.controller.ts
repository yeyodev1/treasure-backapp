import { NextFunction, Request, Response } from "express";
import bcrypt from "bcryptjs";
import { User } from "../models/user.model";
import { USER_ROLES, UserRole } from "../utils/roles";
import { badRequest, notFound } from "../errors/httpError";

export async function listUsers(_req: Request, res: Response, next: NextFunction) {
  try {
    const users = await User.find().select("name email role active createdAt").sort({ name: 1 });
    res.json({ users });
  } catch (err) {
    next(err);
  }
}

export async function createUser(req: Request, res: Response, next: NextFunction) {
  try {
    const { name, email, password, role } = req.body as {
      name?: string;
      email?: string;
      password?: string;
      role?: UserRole;
    };
    if (!name || !email || !password || !role) {
      throw badRequest("Nombre, correo, contraseña y rol son obligatorios");
    }
    if (!USER_ROLES.includes(role)) throw badRequest("Rol inválido");
    if (password.length < 6) throw badRequest("La contraseña debe tener al menos 6 caracteres");

    const exists = await User.findOne({ email: email.toLowerCase().trim() });
    if (exists) throw badRequest("Ya existe una persona con ese correo");

    const user = await User.create({
      name,
      email,
      role,
      passwordHash: await bcrypt.hash(password, 10),
    });
    res.status(201).json({ user: { id: user._id, name: user.name, email: user.email, role } });
  } catch (err) {
    next(err);
  }
}

export async function updateUser(req: Request, res: Response, next: NextFunction) {
  try {
    const { name, role, active, password } = req.body as {
      name?: string;
      role?: UserRole;
      active?: boolean;
      password?: string;
    };

    const user = await User.findById(req.params.id);
    if (!user) throw notFound("Persona no encontrada");

    if (name !== undefined) user.name = name;
    if (role !== undefined) {
      if (!USER_ROLES.includes(role)) throw badRequest("Rol inválido");
      user.role = role;
    }
    if (active !== undefined) user.active = active;
    if (password) {
      if (password.length < 6) throw badRequest("La contraseña debe tener al menos 6 caracteres");
      user.passwordHash = await bcrypt.hash(password, 10);
    }

    await user.save();
    res.json({
      user: { id: user._id, name: user.name, email: user.email, role: user.role, active: user.active },
    });
  } catch (err) {
    next(err);
  }
}
