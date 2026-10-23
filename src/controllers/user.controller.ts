import { NextFunction, Request, Response } from "express";
import bcrypt from "bcryptjs";
import { User } from "../models/user.model";
import { USER_ROLES, UserRole, ROLE_LABELS } from "../utils/roles";
import { logEvent } from "../services/audit.service";
import { badRequest, notFound } from "../errors/httpError";

const PUBLIC_FIELDS = "name email role active isCashier createdBy updatedBy createdAt updatedAt";

export async function listUsers(_req: Request, res: Response, next: NextFunction) {
  try {
    const users = await User.find()
      .select(PUBLIC_FIELDS)
      .populate("createdBy", "name")
      .populate("updatedBy", "name")
      .sort({ active: -1, name: 1 });
    res.json({ users });
  } catch (err) {
    next(err);
  }
}

export async function createUser(req: Request, res: Response, next: NextFunction) {
  try {
    const { name, email, password, role, isCashier } = req.body as {
      name?: string;
      email?: string;
      password?: string;
      role?: UserRole;
      isCashier?: boolean;
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
      isCashier: role === "direccion" && Boolean(isCashier),
      passwordHash: await bcrypt.hash(password, 10),
      createdBy: req.auth!.sub,
    });

    await logEvent(req.auth, {
      kind: "equipo",
      title: `Acceso creado · ${user.name}`,
      detail: ROLE_LABELS[role],
    });
    res.status(201).json({ user: await User.findById(user._id).select(PUBLIC_FIELDS) });
  } catch (err) {
    next(err);
  }
}

export async function updateUser(req: Request, res: Response, next: NextFunction) {
  try {
    const { name, role, active, password, isCashier } = req.body as {
      name?: string;
      role?: UserRole;
      active?: boolean;
      password?: string;
      isCashier?: boolean;
    };

    const user = await User.findById(req.params.id);
    if (!user) throw notFound("Persona no encontrada");
    if (user._id.toString() === req.auth!.sub && active === false) {
      throw badRequest("No puedes desactivar tu propio acceso");
    }

    const changes: string[] = [];
    if (name !== undefined && name !== user.name) {
      user.name = name;
      changes.push("nombre");
    }
    if (role !== undefined && role !== user.role) {
      if (!USER_ROLES.includes(role)) throw badRequest("Rol inválido");
      user.role = role;
      changes.push(`rol ${ROLE_LABELS[role]}`);
    }
    if (active !== undefined && active !== user.active) {
      user.active = active;
      changes.push(active ? "activado" : "desactivado");
    }
    if (isCashier !== undefined && isCashier !== user.isCashier) {
      user.isCashier = isCashier;
      changes.push(isCashier ? "designado cajero" : "sin permiso de cobro");
    }
    if (user.role !== "direccion") user.isCashier = false;
    if (password) {
      if (password.length < 6) throw badRequest("La contraseña debe tener al menos 6 caracteres");
      user.passwordHash = await bcrypt.hash(password, 10);
      changes.push("contraseña");
    }
    user.updatedBy = req.auth!.sub as never;

    await user.save();
    if (changes.length) {
      await logEvent(req.auth, {
        kind: "equipo",
        title: `Acceso editado · ${user.name}`,
        detail: changes.join(", "),
      });
    }
    res.json({
      user: await User.findById(user._id)
        .select(PUBLIC_FIELDS)
        .populate("createdBy", "name")
        .populate("updatedBy", "name"),
    });
  } catch (err) {
    next(err);
  }
}
